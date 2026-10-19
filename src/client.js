// Browser source. scripts/build-client.mjs produces lib/client.js.
import React from "react";
import ReactDOM from "react-dom";
import { TerminalView } from "./terminal-view.js";
import { TerminalController } from "./terminal-controller.js";

const RPC_CHANNEL_BANG = "/shell-bang-rpc";

const PANEL_MIN_WIDTH = 340;
const PANEL_MIN_HEIGHT = 220;

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
	const stripped = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "");
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

/* ---- React component ---- */
const panelStyle = {
	boxSizing: "border-box",
	position: "fixed",
	zIndex: 1000,
	display: "flex",
	flexDirection: "column",
	border: "1px solid var(--dsw-alias-border-l1, color-mix(in srgb, currentColor 22%, transparent))",
	borderRadius: 12,
	// Portaled outside the chat: use the host's actual theme aliases as a pair.
	background: "var(--dsw-alias-bg-layer-1, var(--color-surface, #141414))",
	color: "var(--dsw-alias-label-primary, var(--color-text, #eeeeee))",
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
	borderBottom: active ? "2px solid var(--dsw-alias-state-business-primary, var(--color-accent, #3b7dd8))" : "2px solid transparent",
	background: "transparent",
	color: active ? "inherit" : "var(--dsw-alias-label-secondary, #aaaaaa)",
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
	background: "var(--dsw-alias-bg-module-platform, rgba(0,0,0,.35))",
	lineHeight: 1.45,
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
const inputStyle = {
  flex: 1, background: "transparent", color: "inherit", border: "1px solid #555",
  borderRadius: 6, padding: "4px 8px", fontFamily: "inherit", fontSize: 13,
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
	// HistoryTab remounts on every tab switch (see setTab's comment), so
	// this initializer runs exactly once per mount — good enough to
	// pre-check the entry a just-ended close jumped here to show, without
	// needing an extra effect to keep it in sync.
	const [selected, setSelected] = React.useState(() =>
		state.pendingSelectPath ? new Set([state.pendingSelectPath]) : new Set());
	const [notes, setNotes] = React.useState("");
	const [status, setStatus] = React.useState(null); // { kind: "ok" | "error", text }

	React.useEffect(() => { controller.loadHistory(); /* refresh on mount */ }, [controller]);

// Auto-expand the just-closed entry's preview when the panel jumps here
// after exit() (only for pendingSelectPath, not for manually-selected entries).
React.useEffect(() => {
	if (state.pendingSelectPath) {
		controller.togglePreview(state.pendingSelectPath);
	}
}, [state.pendingSelectPath, controller]);

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
				placeholder: "（可选）已选中多段记录时，可在此补充自然语言说明…",
				onChange: (event) => setNotes(event.target.value),
				style: { ...inputStyle, minHeight: 40, resize: "vertical", fontFamily: "inherit" },
			}),
			React.createElement("div", { style: { fontSize: 11, opacity: 0.6, marginTop: -2 } },
				"提示：不输入时的默认消息为「请帮我分别分析这些历史终端记录。」"
			),
			React.createElement("div", { style: { display: "flex", alignItems: "center", gap: 8 } },
				React.createElement("button", {
					type: "button",
					style: buttonStyle,
					disabled: selected.size === 0,
					onClick: onReferenceInject,
				}, selected.size > 1 ? `引用并分析 (${selected.size} 段)` : "引用并分析"),
			// Dismiss also closes any remaining server handle after a stream error.
				(state.status === "ended" || state.status === "error") ? React.createElement("button", {
					type: "button",
					style: buttonStyle,
					onClick: () => controller.dismiss(),
				}, "直接退出，本次不分析") : null,
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
	const panelRef = React.useRef(null);

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

	const children = [];

	// Header (drag handle). "退出" ends the live PTY (a pure persistence
	// step, no consent prompt); once ended, the same slot becomes "关闭
	// 面板" to dismiss the panel entirely (the panel stays open after
	// exit() so the user can act on the history tab it jumps to).
	const isEnded = state.status === "ended" || state.status === "error";
	const headerButtonLabel = isEnded ? (state.status === "error" ? "关闭" : "关闭面板") : "退出";
	const headerButtonDisabled = state.status === "opening" || state.status === "exiting";
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
			disabled: headerButtonDisabled,
			onMouseDown: (event) => event.stopPropagation(),
			onClick: () => (isEnded ? controller.dismiss() : controller.exit()),
		}, headerButtonLabel),
	));

  const body = [];
  // Keep xterm mounted while browsing history: its cursor and alt buffer are stateful.
  body.push(React.createElement(TerminalView, { key: `terminal-${state.epoch}`, controller,
    visible: state.tab === "live", status: state.status }));
  if (state.tab === "live" && state.status === "open") {
    body.push(React.createElement("div", { key: "controls", style: { display: "flex", gap: 8, flex: "0 0 auto" } },
      ...[["C", "\x03", "中断"], ["D", "\x04", "结束/EOF"], ["Z", "\x1a", "挂起"]].map(([key, bytes, label]) =>
        React.createElement("button", { key, type: "button", style: buttonStyle,
          "aria-label": `Ctrl+${key}（${label}）`, title: `Ctrl+${key}（${label}）`,
          onClick: () => { controller.markActivity(); controller.sendRaw(bytes); controller.terminal?.focus(); },
        }, `^${key}`)),
    ));
  }
  if (state.status === "opening") body.push(React.createElement("div", { key: "opening" }, "正在打开终端…"));
  if (state.status === "exiting") body.push(React.createElement("div", { key: "exiting" }, "正在结束终端会话…"));
  if (state.error) body.push(React.createElement("div", { key: "err", role: "alert", style: { color: "#e06c75" } }, state.error));
  if (state.tab === "history") body.push(React.createElement(HistoryTab, { key: `history-${state.pendingSelectPath || "live"}`, controller, state }));
  if (state.tab === "live" && state.status === "ended") body.push(React.createElement("div", { key: "ended-hint" }, "终端会话已结束，如需继续请重新输入 /terminal。"));
  children.push(React.createElement("div", { key: "body", style: { ...bodyStyle, overflow: "hidden" } }, body));

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
				description: "Open an interactive terminal (reference history on demand)",
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
  ctx.effect(() => {
    const style = document.createElement("style");
    style.dataset.dshShellXterm = "";
    style.textContent = __XTERM_CSS__;
    document.head.appendChild(style);
    return () => style.remove();
  }, "shell-command: xterm styles");
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

export { apply, inject, name };
