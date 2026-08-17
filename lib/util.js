/**
 * dsh-shell-command — small helpers shared across the single-command and
 * terminal-mode paths, kept in one place so a fix here (session shape,
 * envelope schema) can't be applied to one call site and missed on another.
 *
 * @module dsh-shell-command/util
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";

/** The session workspace root for one invocation, falling back to the process cwd. */
export function agentCwd(agent) {
	return agent?.session?.header?.cwd ?? process.cwd();
}

/**
 * Build a plugin-sourced user message. The `source` shape is load-bearing:
 * an unlabeled message renders as an ordinary user prompt in derived history
 * instead of a plugin notice.
 */
export function buildPluginMessage(text, summary) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "plugin", plugin: "shell-command", form: "notice", summary },
	});
}

/**
 * Build a message that renders as an ordinary chat bubble (`source: { kind:
 * "user" }`), not a plugin notice row — for the user's own natural-language
 * notes, split out into their own message so they read like a normal
 * conversational turn rather than being buried inside a transcript block.
 */
export function buildUserMessage(text) {
	return createUserMessage({
		content: [{ type: "text", text }],
		source: { kind: "user" },
	});
}

/** Clamp a PTY dimension (cols/rows) to node-pty's minimum, defaulting on NaN/0. */
export function clampDim(value, fallback) {
	return Math.max(2, Math.floor(value) || fallback);
}
