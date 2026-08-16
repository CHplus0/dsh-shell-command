/**
 * dsh-shell-command — exit-time injection messages (multi-command mode).
 *
 * Two outcomes of the consent gate:
 * - "yes": a full (bounded-tail) transcript + optional user notes, delivered
 *   via `agent.followup` for synchronous analysis.
 * - "no": a one-line pointer via `agent.inject` — no wake, but the model can
 *   read the persisted transcript file on a later turn.
 *
 * @module dsh-shell-command/inject
 */
import { formatSummary } from "./format.js";
import { buildPluginMessage } from "./util.js";

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
 * Build the "yes" followup message: bounded transcript + optional user notes.
 * @returns a frozen user message for `agent.followup`.
 */
export function buildFollowupMessage({ cwd, command, transcript, truncated, exitCode, notes, injectMaxBytes }) {
	const tail = tailTranscript(stripAnsi(transcript), injectMaxBytes);
	const lines = [
		`用户运行了一个终端会话（工作目录：${cwd}），要求分析其内容。`,
	];
	if (notes !== undefined && notes.trim() !== "") {
		lines.push("", `用户补充说明：${notes.trim()}`, "");
	}
	lines.push(
		"终端转录" + (truncated || tail.truncated ? "（有界/已截断）" : "") + "：",
		"```",
		tail.text.trimEnd(),
		"```",
		`退出码：${exitCode === null ? "?" : exitCode}`,
	);
	return buildPluginMessage(lines.join("\n"), formatSummary(command ?? "terminal session"));
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
