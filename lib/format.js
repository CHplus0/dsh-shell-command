/**
 * dsh-shell-command — result shaping for the /shell flow node.
 *
 * Pure, dependency-free: turns a normalized command outcome into the plain
 * text the dispatching UI renders. The same text is used for Mode 1 (display
 * only) and Mode 2 (display + analysis), so the model and the human always see
 * the same bounded transcript.
 *
 * @module dsh-shell-command/format
 */

/** Cap the one-line account carried by an analysis `notice` source. */
const SUMMARY_MAX = 120;

/** A normalized command outcome, produced by `runCommand` in ./exec.js. */
export function formatSummary(command) {
	const summary = `$ ${command}`;
	return summary.length <= SUMMARY_MAX ? summary : `${summary.slice(0, SUMMARY_MAX - 1)}…`;
}

/**
 * Shape one command outcome into the flow-node text.
 * @param outcome - normalized outcome (see ./exec.js `runCommand`).
 * @returns the display text, `$ <command>` first and a status line last.
 */
export function formatResult(outcome) {
	const lines = [`$ ${outcome.command}`];

	appendStream(lines, "stdout", outcome.stdout);
	appendStream(lines, "stderr", outcome.stderr);

	if (outcome.timedOut) {
		lines.push(`[timed out after ${outcome.timeoutMs}ms]`);
	} else if (outcome.cancelled) {
		lines.push("[cancelled]");
	} else if (outcome.signal !== null && outcome.signal !== undefined) {
		lines.push(`[terminated by ${outcome.signal}]`);
	} else {
		lines.push(`[exit code ${outcome.exitCode === null ? "?" : outcome.exitCode}]`);
	}

	return lines.join("\n");
}

/** Append one captured stream (text + truncation marker) under an optional label. */
function appendStream(lines, label, stream) {
	if (stream === undefined) return;
	const text = stream.text ?? "";
	const truncated = stream.truncated === true;
	if (label === "stderr" && text.length === 0 && !truncated) return;
	if (label === "stderr") lines.push("— stderr —");
	if (text.length > 0) lines.push(text.trimEnd());
	if (truncated) lines.push(`…[${label} truncated]…`);
}
