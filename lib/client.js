/* dsh-shell-command client bundle — multi-command terminal popup.
 *
 * Hand-authored (no bundler): registers a standalone `/terminal` command in
 * the input trigger, opens a small terminal panel docked above the
 * composer, streams the PTY over a WebSocket, and on exit shows the consent
 * gate (inject transcript? add notes?). The terminal view is a simple
 * ANSI-stripped scrollback + input line (VT100/xterm fidelity is a follow-up).
 */
window.__ModuleLoader__.load({
	id: "dsh-shell-command",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const reactModule = require("react");
		const React = reactModule && reactModule.default ? reactModule.default : reactModule;
		const runtime = require("@deepseek-ai/dsh-client-runtime/client");
		const createSnapshotStore = runtime.createSnapshotStore;

		const RPC_CHANNEL = "/shell-term-rpc";
		const WS_PATH = "/shell-term/ws";

		/* ANSI/SGR foreground palette (standard 30–37, bright 90–97). */
		const ANSI_COLORS = ["#2e2e2e", "#d64545", "#2e9e4f", "#c9a227", "#3b7dd8", "#9a4ec2", "#1fa8a0", "#d8d8d8"];
		const ANSI_BRIGHT = ["#555555", "#ff6b6b", "#3ddc84", "#f0d264", "#6aa5f8", "#c086e8", "#3dd0c8", "#ffffff"];

		/*
		 * Render ANSI/SGR-colored text as React spans (green prompt, red errors, …).
		 * Matches the full CSI grammar (cursor moves, clear-line, etc.), not just
		 * SGR — non-SGR sequences are consumed and dropped rather than leaking raw
		 * escape bytes into the rendered scrollback (mirrors stripAnsi in inject.js).
		 */
		function renderAnsi(text, keyPrefix) {
			const re = /\x1b\[([0-9;?]*[ -/]*)([@-~])/g;
			const elements = [];
			let last = 0;
			let fg = null;
			let bold = false;
			let key = 0;
			const flush = (chunk, color, weight) => {
				if (chunk.length === 0) return;
				const style = {};
				if (color !== null) style.color = color;
				if (weight) style.fontWeight = "bold";
				elements.push(React.createElement("span", { key: `${keyPrefix}-${key++}`, style }, chunk));
			};
			let match;
			while ((match = re.exec(text)) !== null) {
				if (match.index > last) flush(text.slice(last, match.index), fg, bold);
				if (match[2] !== "m") {
					// Non-SGR CSI (cursor move, clear-line, …): drop, don't render.
					last = re.lastIndex;
					continue;
				}
				const raw = match[1];
				const codes = raw === "" ? [0] : raw.split(";").map((n) => Number(n)).filter((n) => !Number.isNaN(n));
				for (const code of codes) {
					if (code === 0) { fg = null; bold = false; }
					else if (code === 1) bold = true;
					else if (code === 22) bold = false;
					else if (code >= 30 && code <= 37) fg = ANSI_COLORS[code - 30];
					else if (code >= 90 && code <= 97) fg = ANSI_BRIGHT[code - 90];
					else if (code === 39) fg = null;
				}
				last = re.lastIndex;
			}
			if (last < text.length) flush(text.slice(last), fg, bold);
			return elements;
		}

		/* One terminal session's client-side state + host bridge. */
		class TerminalController {
			constructor(connection, sessionId) {
				this.connection = connection;
				this.sessionId = sessionId;
				this.ws = null;
				this.transcript = "";
				this.state = createSnapshotStore({ status: "closed" });
			}

			open() {
				if (this.state.getSnapshot().status !== "closed") return;
				this.setState({ status: "opening" });
				this.connection.rpc.call(RPC_CHANNEL, "open", { sessionId: this.sessionId }, undefined)
					.then((result) => {
						if (result === undefined || !result.ok) {
							this.setState({ status: "error", error: result && result.error ? result.error.message : "open failed" });
							return;
						}
						this.connectWs();
						this.setState({ status: "open", transcript: this.transcript });
					})
					.catch((error) => this.setState({ status: "error", error: error instanceof Error ? error.message : String(error) }));
			}

			connectWs() {
				const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
				const host = typeof location !== "undefined" ? location.host : "";
				this.ws = new WebSocket(`${proto}//${host}${WS_PATH}?sessionId=${encodeURIComponent(this.sessionId)}`);
				this.ws.onmessage = (event) => {
					this.transcript += event.data;
					// Keep the client-side buffer bounded (tail retained); rendering a
					// megabyte of spans would freeze the UI. Cut on a UTF-16 code-unit
					// boundary that isn't inside a surrogate pair (emoji, some CJK
					// extensions), or the split half renders as a replacement glyph.
					if (this.transcript.length > 65536) {
						let cut = this.transcript.length - 65536;
						const code = this.transcript.charCodeAt(cut);
						if (code >= 0xdc00 && code <= 0xdfff) cut += 1;
						this.transcript = this.transcript.slice(cut);
					}
					const current = this.state.getSnapshot();
					if (current.status === "open") this.setState({ status: "open", transcript: this.transcript });
				};
				this.ws.onclose = () => { this.ws = null; };
			}

			send(text) {
				if (this.ws !== null && this.ws.readyState === 1) this.ws.send(text + "\n");
			}

			enterGate() {
				this.setState({ status: "gate", transcript: this.transcript });
			}

			exit(inject, notes) {
				this.setState({ status: "exiting", transcript: this.transcript });
				this.connection.rpc.call(RPC_CHANNEL, "close", { sessionId: this.sessionId, inject, notes: notes || "" }, undefined)
					.then(() => {
						this.closeWs();
						this.setState({ status: "closed" });
					})
					.catch((error) => this.setState({ status: "error", error: error instanceof Error ? error.message : String(error) }));
			}

			dismiss() {
				this.closeWs();
				this.setState({ status: "closed" });
			}

			closeWs() {
				if (this.ws !== null) {
					try { this.ws.close(); } catch { /* ignore */ }
					this.ws = null;
				}
			}

			dispose() {
				this.closeWs();
			}

			setState(next) {
				this.state.set(next);
			}
		}

		/* ---- React component ---- */
		const baseStyle = {
			boxSizing: "border-box",
			width: "100%",
			maxHeight: "min(360px, 55vh)",
			overflowY: "auto",
			position: "relative",
			zIndex: 60,
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: "12px 14px",
			border: "1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 22%, transparent))",
			borderRadius: 12,
			background: "var(--color-surface, #141414)",
			color: "var(--color-text, inherit)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 13,
		};
		const scrollStyle = {
			overflow: "auto",
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			maxHeight: 240,
			minHeight: 80,
			padding: 6,
			borderRadius: 6,
			background: "rgba(0,0,0,.35)",
			lineHeight: 1.45,
		};
		const inputRowStyle = { display: "flex", gap: 8 };
		const inputStyle = {
			flex: 1,
			background: "transparent",
			border: "1px solid color-mix(in srgb, currentColor 22%, transparent)",
			borderRadius: 6,
			padding: "4px 8px",
			color: "inherit",
			fontFamily: "inherit",
			fontSize: 13,
		};
		const buttonStyle = {
			appearance: "none",
			border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
			borderRadius: 7,
			padding: "3px 10px",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			fontSize: 12,
		};

		function ShellTerminal({ controller }) {
			const state = React.useSyncExternalStore(
				(listener) => controller.state.subscribe(listener),
				() => controller.state.getSnapshot(),
			);
			const [draft, setDraft] = React.useState("");
			const [notes, setNotes] = React.useState("");
			const scrollRef = React.useRef(null);

			React.useEffect(() => {
				if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}, [state.transcript, state.status]);

			if (state.status === "closed") return null;

			const onInputKeyDown = (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					controller.send(draft);
					setDraft("");
				}
			};

			const children = [];

			// Header
			children.push(React.createElement("div", {
				key: "h",
				style: { display: "flex", alignItems: "baseline", gap: 8, justifyContent: "space-between" },
			},
				React.createElement("span", { style: { fontWeight: 700, flex: "0 0 auto" } }, "/terminal"),
				React.createElement("button", {
					type: "button",
					style: buttonStyle,
					onClick: () => (state.status === "gate" ? controller.exit(false, notes) : controller.enterGate()),
				}, state.status === "gate" ? "不注入，直接退出" : "退出"),
			));

			if (state.status === "opening") {
				children.push(React.createElement("div", { key: "opening", style: { opacity: .7 } }, "正在打开终端…"));
			} else if (state.status === "error") {
				children.push(React.createElement("div", { key: "err", style: { color: "var(--color-error, #e06c75)" } }, state.error));
			} else if (state.status === "gate") {
				children.push(React.createElement("div", { key: "gate", style: { display: "flex", flexDirection: "column", gap: 8 } },
					React.createElement("div", { style: { opacity: .8 } }, "是否把本次终端内容喂给模型分析？"),
					React.createElement("textarea", {
						value: notes,
						placeholder: "（可选）补充你的自然语言说明…",
						onChange: (event) => setNotes(event.target.value),
						style: { ...inputStyle, minHeight: 40, resize: "vertical", fontFamily: "inherit" },
					}),
					React.createElement("div", { style: { display: "flex", gap: 8 } },
						React.createElement("button", { type: "button", style: buttonStyle, onClick: () => controller.exit(true, notes) }, "注入并分析"),
						React.createElement("button", { type: "button", style: buttonStyle, onClick: () => controller.exit(false, notes) }, "不注入"),
					),
				));
			} else if (state.status === "exiting") {
				children.push(React.createElement("div", { key: "exiting", style: { opacity: .7 } }, "正在结束终端会话…"));
			} else {
				// "open": scrollback + input line
				children.push(React.createElement("div", { key: "scroll", ref: scrollRef, style: scrollStyle }, renderAnsi(state.transcript || "", "scroll")));
				children.push(React.createElement("div", { key: "row", style: inputRowStyle },
					React.createElement("input", {
						autoFocus: true,
						value: draft,
						placeholder: "输入命令，回车执行…",
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: onInputKeyDown,
						style: inputStyle,
					}),
				));
			}

			return React.createElement("div", { style: baseStyle, role: "dialog", "aria-label": "shell terminal" }, children);
		}

		/* ---- input trigger source: a standalone /terminal command (no host-command
		 * collision, unlike `/shell --terminal` which the command directory claims
		 * first). Mirrors dsh-btw's /btw source exactly: candidates + onPick +
		 * matchSpace + a Promise-returning matchEnter. ---- */
		function terminalClaim(controller) {
			return {
				token: "/terminal ",
				hint: "[interactive terminal]",
				submit: () => {
					controller.open();
					return Promise.resolve({ kind: "success" });
				},
			};
		}

		function enterClaim(controllerFor, sessionId, line) {
			const match = /^\s*\/terminal\s*$/iu.exec(line);
			if (match === null) return undefined;
			return { claim: terminalClaim(controllerFor(sessionId)) };
		}

		function createTerminalSource(controllerFor) {
			return {
				trigger: "/",
				name: "terminal",
				order: -5,
				candidates(_session, request) {
					if (request.position !== "leading" || !"terminal".startsWith(request.query.toLowerCase())) return Promise.resolve([]);
					return Promise.resolve([{
						name: "terminal",
						description: "Open an interactive terminal (inject its transcript on exit)",
						hint: "[terminal]",
					}]);
				},
				onPick(pick) {
					return { claim: terminalClaim(controllerFor(pick.session.sessionId)) };
				},
				matchSpace(session, token) {
					return /^\/terminal$/iu.test(token) ? { claim: terminalClaim(controllerFor(session.sessionId)) } : undefined;
				},
				matchEnter(session, line) {
					return Promise.resolve(enterClaim(controllerFor, session.sessionId, line));
				},
			};
		}

		/* ---- plugin apply ---- */
		const name = "shell-command-client";
		const inject = ["connection", "inputTriggers", "sessions", "slots"];

		function apply(ctx) {
			const connection = ctx.get("connection");
			const inputTriggers = ctx.get("inputTriggers");
			const sessions = ctx.get("sessions");
			const slots = ctx.slots;
			if (connection === undefined || inputTriggers === undefined || sessions === undefined || slots === undefined) {
				throw new Error("dsh-shell-command/client requires connection, inputTriggers, sessions, and slots");
			}

			const controllers = new Map();
			const controllerFor = (sessionId) => {
				let controller = controllers.get(sessionId);
				if (controller === undefined) {
					controller = new TerminalController(connection, sessionId);
					controllers.set(sessionId, controller);
				}
				return controller;
			};

			ctx.effect(() => inputTriggers.registerSource(createTerminalSource(controllerFor)), "shell-command: terminal input source");
			ctx.effect(() => () => {
				for (const controller of controllers.values()) controller.dispose();
				controllers.clear();
			}, "shell-command: terminal controllers");

			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
				name: "conversation.input.dock",
				id: "shell-term-panel",
				order: 3,
				inject: (sessionId) => {
					const actx = sessions.scope(sessionId);
					if (actx === undefined) throw new Error(`dsh-shell-command: session "${String(sessionId)}" resolved no client scope`);
					const controller = controllerFor(sessionId);
					actx.effect(() => () => {
						if (controllers.get(sessionId) === controller) controllers.delete(sessionId);
						controller.dispose();
					}, "shell-command: session terminal");
					return { controller };
				},
			}, ShellTerminal));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
