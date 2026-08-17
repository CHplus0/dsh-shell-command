/* dsh-shell-command client bundle — multi-command terminal popup.
 *
 * Hand-authored (no bundler): registers a standalone `/terminal` command in
 * the input trigger and opens a floating (freely movable/resizable) terminal
 * panel via a portal to `document.body`. The panel streams the PTY over a
 * WebSocket, shows a "会话"/"历史" tab pair, and on exit shows the consent
 * gate (inject transcript? add notes?). The live view is a simple
 * ANSI-stripped scrollback + input line (VT100/xterm fidelity is a follow-up).
 */
window.__ModuleLoader__.load({
	id: "dsh-shell-command",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const reactModule = require("react");
		const React = reactModule && reactModule.default ? reactModule.default : reactModule;
		const reactDomModule = require("react-dom");
		const ReactDOM = reactDomModule && reactDomModule.default ? reactDomModule.default : reactDomModule;
		const runtime = require("@deepseek-ai/dsh-client-runtime/client");
		const createSnapshotStore = runtime.createSnapshotStore;

		const RPC_CHANNEL = "/shell-term-rpc";
		const RPC_CHANNEL_BANG = "/shell-bang-rpc";
		const WS_PATH = "/shell-term/ws";

		const PANEL_MIN_WIDTH = 340;
		const PANEL_MIN_HEIGHT = 220;
		const PANEL_DEFAULT_WIDTH = 460;
		const PANEL_DEFAULT_HEIGHT = 420;

		function clampNum(value, min, max) {
			return Math.max(min, Math.min(value, max));
		}

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
			// Strip OSC sequences (e.g. bash's `\x1b]0;title\x07` window-title set)
			// before the CSI/SGR tokenizer runs below — otherwise they render as
			// literal garbled bytes right before the real (correctly colored) prompt.
			// Mirrors stripAnsi's OSC handling in inject.js.
			const stripped = text.replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
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
			while ((match = re.exec(stripped)) !== null) {
				if (match.index > last) flush(stripped.slice(last, match.index), fg, bold);
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
			if (last < stripped.length) flush(stripped.slice(last), fg, bold);
			return elements;
		}

		/* One terminal session's client-side state + host bridge. */
		class TerminalController {
			constructor(connection, sessionId) {
				this.connection = connection;
				this.sessionId = sessionId;
				this.ws = null;
				this.transcript = "";
				this.state = createSnapshotStore({
					status: "closed",
					tab: "live",
					// Floating panel geometry — freely movable/resizable, portal-rendered.
					x: null,
					y: null,
					width: PANEL_DEFAULT_WIDTH,
					height: PANEL_DEFAULT_HEIGHT,
					history: { entries: [], loading: false, error: null },
					preview: null, // { path, transcript } | null
				});
			}

			open() {
				if (this.state.getSnapshot().status !== "closed") return;
				// this.transcript is an instance field that outlives one open/close
				// cycle (the controller is cached per sessionId across many
				// /terminal invocations). The server always hands back a fresh PTY
				// on open, so the client buffer must reset here too — otherwise the
				// previous session's scrollback leaks into the new one's.
				this.transcript = "";
				this.setState({ status: "opening", tab: "live", transcript: "" });
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

			/** Send a raw byte sequence immediately (control chars: Ctrl+C/D/Z), bypassing line buffering. */
			sendRaw(bytes) {
				if (this.ws !== null && this.ws.readyState === 1) this.ws.send(bytes);
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
				this.state.set({ ...this.state.getSnapshot(), ...next });
			}

			/* ---- panel geometry (drag/resize) ---- */
			setGeometry(patch) {
				this.setState(patch);
			}

			/* ---- history tab ---- */
			setTab(tab) {
				// HistoryTab's own mount effect calls loadHistory() when it mounts
				// (it unmounts/remounts on every tab switch), so no need to trigger
				// a second fetch here.
				this.setState({ tab, preview: null });
			}

			loadHistory() {
				this.setState({ history: { ...this.state.getSnapshot().history, loading: true, error: null } });
				this.connection.rpc.call(RPC_CHANNEL, "historyList", { sessionId: this.sessionId }, undefined)
					.then((result) => {
						if (result === undefined || !result.ok) {
							this.setState({ history: { entries: [], loading: false, error: result && result.error ? result.error.message : "load failed" } });
							return;
						}
						this.setState({ history: { entries: result.value.entries, loading: false, error: null } });
					})
					.catch((error) => this.setState({ history: { entries: [], loading: false, error: error instanceof Error ? error.message : String(error) } }));
			}

			togglePreview(path) {
				const current = this.state.getSnapshot().preview;
				if (current !== null && current.path === path) {
					this.setState({ preview: null });
					return;
				}
				this.setState({ preview: { path, transcript: null, loading: true } });
				this.connection.rpc.call(RPC_CHANNEL, "historyRead", { sessionId: this.sessionId, path }, undefined)
					.then((result) => {
						if (result === undefined || !result.ok) {
							this.setState({ preview: { path, transcript: result && result.error ? result.error.message : "read failed", loading: false } });
							return;
						}
						this.setState({ preview: { path, transcript: result.value.transcript, loading: false } });
					})
					.catch((error) => this.setState({ preview: { path, transcript: error instanceof Error ? error.message : String(error), loading: false } }));
			}

			/** Reference-inject the given transcript paths (multi-select) + notes; non-waking. */
			referenceInject(paths, notes) {
				return this.connection.rpc.call(RPC_CHANNEL, "historyInject", { sessionId: this.sessionId, paths, notes: notes || "" }, undefined)
					.then((result) => {
						if (result === undefined || !result.ok) {
							throw new Error(result && result.error ? result.error.message : "reference-inject failed");
						}
						return result.value;
					});
			}
		}

		/* ---- React component ---- */
		const panelStyle = {
			boxSizing: "border-box",
			position: "fixed",
			zIndex: 1000,
			display: "flex",
			flexDirection: "column",
			border: "1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 22%, transparent))",
			borderRadius: 12,
			background: "var(--color-surface, #141414)",
			color: "var(--color-text, inherit)",
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
			fontSize: 13,
			boxShadow: "0 8px 30px rgba(0,0,0,.35)",
			overflow: "hidden",
		};
		const headerStyle = {
			display: "flex",
			alignItems: "center",
			gap: 8,
			justifyContent: "space-between",
			padding: "8px 10px",
			cursor: "move",
			userSelect: "none",
			borderBottom: "1px solid color-mix(in srgb, currentColor 16%, transparent)",
			flex: "0 0 auto",
		};
		const bodyStyle = {
			flex: "1 1 auto",
			display: "flex",
			flexDirection: "column",
			gap: 8,
			padding: "10px 12px",
			overflow: "auto",
			minHeight: 0,
		};
		const tabRowStyle = { display: "flex", gap: 4, flex: "0 0 auto" };
		const tabButtonStyle = (active) => ({
			appearance: "none",
			border: "none",
			borderBottom: active ? "2px solid var(--color-accent, #3b7dd8)" : "2px solid transparent",
			background: "transparent",
			color: active ? "inherit" : "color-mix(in srgb, currentColor 60%, transparent)",
			cursor: "pointer",
			fontSize: 12,
			fontWeight: active ? 700 : 400,
			padding: "4px 2px",
		});
		const scrollStyle = {
			overflow: "auto",
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			flex: "1 1 auto",
			minHeight: 60,
			padding: 6,
			borderRadius: 6,
			background: "rgba(0,0,0,.35)",
			lineHeight: 1.45,
		};
		// Ctrl+<key> -> raw control byte sent immediately (bypasses line buffering).
		const CTRL_KEY_BYTES = { c: "\x03", d: "\x04", z: "\x1a" };
		const inputRowStyle = { display: "flex", gap: 8, flex: "0 0 auto" };
		const ctrlButtonStyle = {
			appearance: "none",
			border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
			borderRadius: 7,
			padding: "3px 8px",
			background: "transparent",
			color: "inherit",
			cursor: "pointer",
			fontSize: 11,
			flex: "0 0 auto",
		};
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
		const resizeGripStyle = {
			position: "absolute",
			right: 0,
			bottom: 0,
			width: 16,
			height: 16,
			cursor: "nwse-resize",
			background: "linear-gradient(135deg, transparent 50%, color-mix(in srgb, currentColor 35%, transparent) 50%)",
		};
		const historyRowStyle = {
			display: "flex",
			flexDirection: "column",
			gap: 4,
			padding: "6px 8px",
			borderRadius: 6,
			border: "1px solid color-mix(in srgb, currentColor 14%, transparent)",
		};
		const historyHeaderRowStyle = { display: "flex", alignItems: "center", gap: 8 };
		const badgeStyle = (tone) => ({
			fontSize: 11,
			padding: "1px 6px",
			borderRadius: 999,
			background: tone === "warn" ? "color-mix(in srgb, #e0b95e 30%, transparent)" : "color-mix(in srgb, currentColor 14%, transparent)",
		});

		/** Drag the header to move the panel; clamps to the viewport. */
		function useDrag(controller, state) {
			const dragRef = React.useRef(null);
			const onHeaderMouseDown = (event) => {
				if (event.button !== 0) return;
				const rect = event.currentTarget.parentElement.getBoundingClientRect();
				dragRef.current = { startX: event.clientX, startY: event.clientY, originX: rect.left, originY: rect.top };
				event.preventDefault();
			};
			React.useEffect(() => {
				const onMove = (event) => {
					if (dragRef.current === null) return;
					const { startX, startY, originX, originY } = dragRef.current;
					const width = state.width;
					const height = state.height;
					const nextX = clampNum(originX + (event.clientX - startX), 0, Math.max(0, window.innerWidth - width));
					const nextY = clampNum(originY + (event.clientY - startY), 0, Math.max(0, window.innerHeight - height));
					controller.setGeometry({ x: nextX, y: nextY });
				};
				const onUp = () => { dragRef.current = null; };
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
			}, [controller, state.width, state.height]);
			return onHeaderMouseDown;
		}

		/** Drag the corner grip to resize the panel; clamps to a minimum and the viewport. */
		function useResize(controller, state) {
			const resizeRef = React.useRef(null);
			const onGripMouseDown = (event) => {
				if (event.button !== 0) return;
				resizeRef.current = { startX: event.clientX, startY: event.clientY, startWidth: state.width, startHeight: state.height };
				event.preventDefault();
				event.stopPropagation();
			};
			React.useEffect(() => {
				const onMove = (event) => {
					if (resizeRef.current === null) return;
					const { startX, startY, startWidth, startHeight } = resizeRef.current;
					const maxWidth = Math.max(PANEL_MIN_WIDTH, window.innerWidth - (state.x ?? 0));
					const maxHeight = Math.max(PANEL_MIN_HEIGHT, window.innerHeight - (state.y ?? 0));
					const nextWidth = clampNum(startWidth + (event.clientX - startX), PANEL_MIN_WIDTH, maxWidth);
					const nextHeight = clampNum(startHeight + (event.clientY - startY), PANEL_MIN_HEIGHT, maxHeight);
					controller.setGeometry({ width: nextWidth, height: nextHeight });
				};
				const onUp = () => { resizeRef.current = null; };
				window.addEventListener("mousemove", onMove);
				window.addEventListener("mouseup", onUp);
				return () => {
					window.removeEventListener("mousemove", onMove);
					window.removeEventListener("mouseup", onUp);
				};
			}, [controller, state.x, state.y]);
			return onGripMouseDown;
		}

		function formatExitBadge(exitCode) {
			if (exitCode === null || exitCode === undefined) return null;
			return exitCode === 0
				? React.createElement("span", { style: badgeStyle("ok") }, "退出码 0")
				: React.createElement("span", { style: badgeStyle("warn") }, `退出码 ${exitCode}`);
		}

		function HistoryTab({ controller, state }) {
			const { entries, loading, error } = state.history;
			const [selected, setSelected] = React.useState(() => new Set());
			const [notes, setNotes] = React.useState("");
			const [status, setStatus] = React.useState(null); // { kind: "ok" | "error", text }

			React.useEffect(() => { controller.loadHistory(); /* refresh on mount */ }, [controller]);

			const toggleSelected = (path) => {
				setSelected((prev) => {
					const next = new Set(prev);
					if (next.has(path)) next.delete(path); else next.add(path);
					return next;
				});
			};

			const onReferenceInject = () => {
				const paths = Array.from(selected);
				if (paths.length === 0) return;
				setStatus(null);
				controller.referenceInject(paths, notes)
					.then((value) => {
						setStatus({ kind: "ok", text: `已引用 ${value.referenced} 段历史记录，模型正在分析…` });
						setSelected(new Set());
						setNotes("");
					})
					.catch((err) => setStatus({ kind: "error", text: err instanceof Error ? err.message : String(err) }));
			};

			if (loading && entries.length === 0) {
				return React.createElement("div", { style: { opacity: .7 } }, "正在加载历史记录…");
			}
			if (error !== null) {
				return React.createElement("div", { style: { color: "var(--color-error, #e06c75)" } }, error);
			}
			if (entries.length === 0) {
				return React.createElement("div", { style: { opacity: .7 } }, "暂无历史终端记录。");
			}

			return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 8, minHeight: 0, flex: "1 1 auto", overflow: "auto" } },
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, overflow: "auto" } },
					entries.map((entry) => {
						const isOpen = state.preview !== null && state.preview.path === entry.path;
						return React.createElement("div", { key: entry.path, style: historyRowStyle },
							React.createElement("div", { style: historyHeaderRowStyle },
								React.createElement("input", {
									type: "checkbox",
									checked: selected.has(entry.path),
									onChange: () => toggleSelected(entry.path),
								}),
								React.createElement("span", { style: { flex: "1 1 auto", fontSize: 12 } }, new Date(entry.timestamp).toLocaleString()),
								formatExitBadge(entry.exitCode),
								entry.injected
									? React.createElement("span", { style: badgeStyle("ok") }, "已注入分析")
									: React.createElement("span", { style: badgeStyle("plain") }, "仅存档"),
								entry.truncated ? React.createElement("span", { style: badgeStyle("warn") }, "已截断") : null,
								React.createElement("button", {
									type: "button",
									style: { ...buttonStyle, padding: "2px 8px" },
									onClick: () => controller.togglePreview(entry.path),
								}, isOpen ? "收起" : "查看"),
							),
							isOpen ? React.createElement("div", { style: { ...scrollStyle, maxHeight: 160, flex: "0 0 auto" } },
								state.preview.loading ? "正在读取…" : renderAnsi(state.preview.transcript || "", entry.path),
							) : null,
						);
					}),
				),
				React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: 6, flex: "0 0 auto", borderTop: "1px solid color-mix(in srgb, currentColor 14%, transparent)", paddingTop: 8 } },
					React.createElement("textarea", {
						value: notes,
						placeholder: "（可选）已选中多段记录时，可在此补充自然语言说明，便于模型横向比较…",
						onChange: (event) => setNotes(event.target.value),
						style: { ...inputStyle, minHeight: 40, resize: "vertical", fontFamily: "inherit" },
					}),
					React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
						React.createElement("button", {
							type: "button",
							style: buttonStyle,
							disabled: selected.size === 0,
							onClick: onReferenceInject,
						}, selected.size > 1 ? `引用并分析 (${selected.size} 段)` : "引用并分析"),
						status !== null ? React.createElement("span", {
							style: { fontSize: 12, color: status.kind === "error" ? "var(--color-error, #e06c75)" : "inherit", opacity: .85 },
						}, status.text) : null,
					),
				),
			);
		}

		function ShellTerminal({ controller }) {
			const state = React.useSyncExternalStore(
				(listener) => controller.state.subscribe(listener),
				() => controller.state.getSnapshot(),
			);
			const [draft, setDraft] = React.useState("");
			const [notes, setNotes] = React.useState("");
			const scrollRef = React.useRef(null);
			const panelRef = React.useRef(null);

			React.useEffect(() => {
				if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
			}, [state.transcript, state.status, state.tab]);

			// First open: default to a centered position now that we know the viewport.
			React.useEffect(() => {
				if (state.status !== "closed" && state.x === null) {
					const x = clampNum((window.innerWidth - state.width) / 2, 0, Math.max(0, window.innerWidth - state.width));
					const y = clampNum((window.innerHeight - state.height) / 2, 0, Math.max(0, window.innerHeight - state.height));
					controller.setGeometry({ x, y });
				}
			}, [controller, state.status, state.x, state.width, state.height]);

			const onHeaderMouseDown = useDrag(controller, state);
			const onGripMouseDown = useResize(controller, state);

			if (state.status === "closed" || state.x === null) return null;

			const onInputKeyDown = (event) => {
				if (event.key === "Enter") {
					event.preventDefault();
					controller.send(draft);
					setDraft("");
					return;
				}
				// Control chars (SIGINT/EOF/SIGTSTP) must land immediately, not wait
				// for Enter — you're often interrupting a command that's still
				// running, e.g. Ctrl+C on a stuck `sleep 100`. The browser doesn't
				// intercept these combos for a plain <input>, so they reach us here.
				if (event.ctrlKey && !event.altKey && !event.metaKey) {
					const raw = CTRL_KEY_BYTES[event.key.toLowerCase()];
					if (raw !== undefined) {
						event.preventDefault();
						controller.sendRaw(raw);
					}
				}
			};

			const children = [];

			// Header (drag handle)
			children.push(React.createElement("div", {
				key: "h",
				style: headerStyle,
				onMouseDown: onHeaderMouseDown,
			},
				React.createElement("span", { style: { fontWeight: 700, flex: "0 0 auto" } }, "/terminal"),
				React.createElement("div", { style: tabRowStyle, onMouseDown: (event) => event.stopPropagation() },
					React.createElement("button", { type: "button", style: tabButtonStyle(state.tab === "live"), onClick: () => controller.setTab("live") }, "会话"),
					React.createElement("button", { type: "button", style: tabButtonStyle(state.tab === "history"), onClick: () => controller.setTab("history") }, "历史"),
				),
				React.createElement("button", {
					type: "button",
					style: { ...buttonStyle, flex: "0 0 auto" },
					onMouseDown: (event) => event.stopPropagation(),
					onClick: () => (state.status === "gate" ? controller.exit(false, notes) : controller.enterGate()),
				}, state.status === "gate" ? "不注入，直接退出" : "退出"),
			));

			const body = [];
			if (state.status === "opening") {
				body.push(React.createElement("div", { key: "opening", style: { opacity: .7 } }, "正在打开终端…"));
			} else if (state.status === "error") {
				body.push(React.createElement("div", { key: "err", style: { color: "var(--color-error, #e06c75)" } }, state.error));
			} else if (state.status === "gate") {
				body.push(React.createElement("div", { key: "gate", style: { display: "flex", flexDirection: "column", gap: 8 } },
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
				body.push(React.createElement("div", { key: "exiting", style: { opacity: .7 } }, "正在结束终端会话…"));
			} else if (state.tab === "history") {
				body.push(React.createElement(HistoryTab, { key: "history", controller, state }));
			} else {
				// "open" + live tab: scrollback + input line
				body.push(React.createElement("div", { key: "scroll", ref: scrollRef, style: scrollStyle }, renderAnsi(state.transcript || "", "scroll")));
				body.push(React.createElement("div", { key: "row", style: inputRowStyle },
					React.createElement("input", {
						autoFocus: true,
						value: draft,
						placeholder: "输入命令，回车执行…（支持 Ctrl+C/D/Z）",
						onChange: (event) => setDraft(event.target.value),
						onKeyDown: onInputKeyDown,
						style: inputStyle,
					}),
					React.createElement("button", { type: "button", title: "Ctrl+C（中断）", style: ctrlButtonStyle, onClick: () => controller.sendRaw(CTRL_KEY_BYTES.c) }, "^C"),
					React.createElement("button", { type: "button", title: "Ctrl+D（结束/EOF）", style: ctrlButtonStyle, onClick: () => controller.sendRaw(CTRL_KEY_BYTES.d) }, "^D"),
					React.createElement("button", { type: "button", title: "Ctrl+Z（挂起）", style: ctrlButtonStyle, onClick: () => controller.sendRaw(CTRL_KEY_BYTES.z) }, "^Z"),
				));
			}
			children.push(React.createElement("div", { key: "body", style: bodyStyle }, body));

			const panel = React.createElement("div", {
				ref: panelRef,
				style: { ...panelStyle, left: state.x, top: state.y, width: state.width, height: state.height },
				role: "dialog",
				"aria-label": "shell terminal",
			},
				children,
				React.createElement("div", { style: resizeGripStyle, onMouseDown: onGripMouseDown }),
			);

			return ReactDOM.createPortal(panel, document.body);
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

		/* ---- '/!' shell command trigger source: one-shot command execution + analysis ---- */
		function createBangSource(connection) {
			// Shared RPC invoker
			const runCommand = (sessionId, command) => {
				if (command.length === 0) {
					return Promise.resolve({ kind: "error", text: "Usage: /! <command>" });
				}
				return connection.rpc.call(RPC_CHANNEL_BANG, "run", { sessionId, command }, undefined)
					.then((result) => {
						if (result === undefined || !result.ok) {
							return { kind: "error", text: result && result.error ? result.error.message : "command execution failed" };
						}
						return { kind: "success" };
					})
					.catch((error) => ({ kind: "error", text: error instanceof Error ? error.message : String(error) }));
			};

			return {
				trigger: "/",
				name: "shell-bang",
				order: -10,
				candidates(_session, request) {
					if (request.position !== "leading") return Promise.resolve([]);
					if (!"!".startsWith(request.query.toLowerCase())) return Promise.resolve([]);
					return Promise.resolve([{
						name: "!",
						description: "Run a shell command and analyze its output",
						hint: "<command>",
					}]);
				},
				onPick({ session }) {
					return {
						claim: {
							token: "/!",
							hint: "<command>",
							submit: (line) => {
								const command = line.replace(/^\/!\s*/, "").trim();
								return runCommand(session.sessionId, command);
							},
						},
					};
				},
				matchSpace(session, token) {
					if (token !== "/!") return undefined;
					return {
						claim: {
							token: "/! ",
							hint: "<command>",
							submit: (line) => {
								const command = line.replace(/^\/!\s*/, "").trim();
								return runCommand(session.sessionId, command);
							},
						},
					};
				},
				matchEnter(session, line) {
					const match = /^\/!\s*(.+)$/u.exec(line);
					if (match === null) return Promise.resolve(undefined);
					const command = match[1].trim();
					return Promise.resolve({
						claim: {
							token: line,
							hint: "",
							submit: () => runCommand(session.sessionId, command),
						},
					});
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
			ctx.effect(() => inputTriggers.registerSource(createBangSource(connection)), "shell-command: bang input source");
			ctx.effect(() => () => {
				for (const controller of controllers.values()) controller.dispose();
				controllers.clear();
			}, "shell-command: terminal controllers");

			// The panel is portal-rendered to document.body (see ShellTerminal), so
			// this slot registration only needs to mount the component once per
			// session — it no longer occupies visible space in the input dock.
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
