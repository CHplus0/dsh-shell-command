/**
 * dsh-shell-command — exit-time and history-reference injection messages
 * (multi-command mode).
 *
 * Two outcomes of the close consent gate:
 * - "yes": the user's notes (own message) + a bounded-tail transcript
 *   (separate message), delivered via `agent.inject` + `agent.followup` for
 *   synchronous analysis — one wake, two ordinary chat bubbles.
 * - "no": a one-line pointer via `agent.inject` — no wake, but the model can
 *   read the persisted transcript file on a later turn.
 *
 * The history tab's "引用并分析" action follows the same "notes" pairing as
 * the "yes" path — see `buildHistoryPointerMessage`.
 *
 * @module dsh-shell-command/inject
 */
import { formatSummary } from "./format.js";
import { buildPluginMessage, buildUserMessage } from "./util.js";

const DEFAULT_CLOSE_NOTES = "我刚结束了一个终端会话，请帮我分析。";
const DEFAULT_HISTORY_NOTES = "请帮我对比分析这些历史终端记录。";

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
 * Build the "yes" followup message: bounded transcript only. The user's own
 * natural-language notes are a separate message (see `buildCloseNotesMessage`),
 * queued via `agent.inject` just before this one via `agent.followup` — `inject`
 * targets the next step, `followup` opens the next turn, and the turn's first
 * step claims both queued items together (inject-queued first, then the
 * followup message), so the pair lands as two ordinary chat bubbles in one
 * turn instead of one waking call each.
 * @returns a frozen user message for `agent.followup`.
 */
export function buildFollowupMessage({ cwd, command, transcript, truncated, exitCode, injectMaxBytes, transcriptPath }) {
	const tail = tailTranscript(stripAnsi(transcript), injectMaxBytes);
	const lines = [
		`用户刚结束了一个终端会话（工作目录：${cwd}），要求你只分析下面这一段转录内容${transcriptPath ? `（对应文件：${transcriptPath}）` : ""}。`,
		"如果对话历史中还有其他终端会话的记录或指针消息，那些是不同时间的会话，与本次分析无关，不要一并读取或混入分析。",
		"终端转录" + (truncated || tail.truncated ? "（有界/已截断）" : "") + "：",
		"```",
		tail.text.trimEnd(),
		"```",
		`退出码：${exitCode === null ? "?" : exitCode}`,
	];
	return buildPluginMessage(lines.join("\n"), formatSummary(command ?? "terminal session"));
}

/**
 * Build the user's own notes as a standalone ordinary-looking chat message
 * (`source: { kind: "user" }`), queued via `agent.inject` ahead of the
 * transcript's `agent.followup` call. Falls back to a default account when
 * the user left the notes field empty, since the consent-gate action itself
 * ("注入并分析") is the thing being spoken for.
 */
export function buildCloseNotesMessage(notes) {
	const text = notes !== undefined && notes.trim() !== "" ? notes.trim() : DEFAULT_CLOSE_NOTES;
	return buildUserMessage(text);
}

/**
 * Build the "no" pointer message for `agent.inject`: a non-waking notice that
 * a transcript exists and where the model can read it later.
 */
export function buildPointerMessage({ cwd, transcriptPath, bytes }) {
	return buildPluginMessage(
		`用户结束了一个终端会话（工作目录：${cwd}），转录已保存到 ${transcriptPath}（约 ${bytes} 字节）。若本次任务需要参考该终端操作，请读取该文件。`,
		"终端会话已保存",
	);
}

/**
 * Build the history-tab "reference" pointer message for `agent.followup`: one
 * or more past (already-closed) terminal transcripts the user picked to
 * compare. Wakes the model synchronously, same as the close consent gate's
 * "yes" path — the pointer stays deliberately content-free (no transcript
 * text embedded, just paths/timestamps/exit codes), since a rerun of the same
 * command between persist time and read time may have produced different
 * output, and the model must not mistake this for a just-happened event; it
 * has to actually read the referenced files to see their content. The user's
 * own notes are a separate message (see `buildHistoryNotesMessage`), queued
 * via `agent.inject` right before this one (see `buildFollowupMessage`'s
 * docstring for why that pairing produces one wake, not two).
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
