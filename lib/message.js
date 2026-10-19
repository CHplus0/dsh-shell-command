/**
 * dsh-shell-command — analysis message construction for the `/!` command trigger.
 *
 * Builds one identified, frozen user-role message carrying the command
 * transcript, then hands it to the agent's `followup` seam so a fresh turn
 * analyzes the output synchronously. The `source` is a load-bearing `plugin`
 * label: an unlabeled message would render as an ordinary user prompt in
 * derived history.
 *
 * @module dsh-shell-command/message
 */
import { buildPluginMessage } from "./util.js";

/** Built-in analysis prompt (Chinese); config `analysisPrompt` overrides it. */
function defaultPrompt(command, cwd, outputText) {
	return [
		`用户通过 /! 触发器在会话工作目录运行了以下命令：`,
		``,
		`工作目录：${cwd}`,
		``,
		`$ ${command}`,
		``,
		outputText,
		``,
		`请分析这个命令的运行结果。`,
	].join("\n");
}

/**
 * Create the analysis message for the `/!` command trigger.
 * @param opts.command - verbatim command line.
 * @param opts.cwd - working directory the command ran in.
 * @param opts.outputText - the already-formatted, bounded transcript.
 * @param opts.summary - one-line account for the `notice` source.
 * @param opts.template - optional prompt template ({command}/{cwd}/{output}).
 * @returns a frozen user-role message for `agent.followup`.
 */
export function createAnalysisMessage({ command, cwd, outputText, summary, template }) {
	const text = template
		? template.replace(/\{(command|cwd|output)\}/g, (_match, key) => ({ command, cwd, output: outputText })[key])
		: defaultPrompt(command, cwd, outputText);

	return buildPluginMessage(text, summary);
}
