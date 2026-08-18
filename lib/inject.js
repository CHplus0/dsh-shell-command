/**
 * dsh-shell-command — history-reference injection messages (multi-command
 * mode) + shared transcript text helpers.
 *
 * Closing a `/terminal` session never sends anything to the model — not for
 * empty sessions (no input ever sent, see `TerminalHandle.hasInput` in
 * terminal.js), not for non-empty ones either. The only way a terminal
 * transcript reaches the model is the history tab's "引用并分析" action,
 * which the user triggers explicitly at any later time: notes (the user's
 * own words) via `agent.inject` (queued, no wake), immediately followed by a
 * content-free pointer via `agent.followup` (wakes the model; see
 * `buildHistoryPointerMessage`'s docstring for why the pair produces one
 * wake, not two).
 *
 * @module dsh-shell-command/inject
 */
import { buildPluginMessage, buildUserMessage } from "./util.js";

const DEFAULT_HISTORY_NOTES = "请帮我分别分析这些历史终端记录。";

/** Strip common ANSI/SGR escape sequences so model context stays readable. */
export function stripAnsi(text) {
	// eslint-disable-next-line no-control-regex
	return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, "");
}

/** Tail-retain a transcript down to `maxBytes` (UTF-8, on character boundaries). */
export function tailTranscript(text, maxBytes) {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };
	let slice = text;
	while (Buffer.byteLength(slice, "utf8") > maxBytes && slice.length > 1) {
		slice = slice.slice(Math.floor(slice.length / 2));
	}
	return { text: slice, truncated: true };
}

/**
 * Build the history-tab "reference" pointer message for `agent.followup`: one
 * or more past (already-closed) terminal transcripts the user picked to
 * compare. Wakes the model synchronously — the pointer stays deliberately
 * content-free (no transcript text embedded, just paths/timestamps/exit
 * codes), since a rerun of the same command between persist time and read
 * time may have produced different output, and the model must not mistake
 * this for a just-happened event; it has to actually read the referenced
 * files to see their content. The user's own notes are a separate message
 * (see `buildHistoryNotesMessage`), queued via `agent.inject` right before
 * this one: `inject` targets the next step, `followup` opens the next turn,
 * and the turn's first step claims both queued items together (inject-queued
 * first, then the followup message), so the pair lands as two ordinary chat
 * bubbles in one turn instead of one waking call each.
 */
export function buildHistoryPointerMessage({ cwd, entries }) {
	const lines = [
		`用户从终端历史记录中选择了 ${entries.length} 段过往会话转录，供你对比参考（工作目录：${cwd}）。`,
		"注意：这些是历史记录，不是刚刚发生的操作；若涉及命令结果，重新运行可能已得到不同输出。",
		"",
	];
	entries.forEach((entry, index) => {
		const exitCode = entry.exitCode === null || entry.exitCode === undefined ? "?" : entry.exitCode;
		lines.push(`${index + 1}. ${entry.path}（时间：${entry.timestamp}，退出码：${exitCode}${entry.truncated ? "，已截断" : ""}）`);
	});
	lines.push("", "如需查看具体内容，请读取以上文件。");
	return buildPluginMessage(lines.join("\n"), `引用 ${entries.length} 段终端历史`);
}

/**
 * Build the user's own notes for a history reference-inject as a standalone
 * ordinary-looking chat message (`source: { kind: "user" }`), queued via
 * `agent.inject` ahead of `buildHistoryPointerMessage`'s call. Falls back to
 * a default account when the notes field was left empty.
 */
export function buildHistoryNotesMessage(notes) {
	const text = notes !== undefined && notes.trim() !== "" ? notes.trim() : DEFAULT_HISTORY_NOTES;
	return buildUserMessage(text);
}
