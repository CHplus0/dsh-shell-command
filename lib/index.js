/**
 * dsh-shell-command — a `/shell` slash command for DeepSeek Harness.
 *
 * Runs a command in the receiving agent's session workspace and renders its
 * output as a conversation flow node, mirroring Claude Code's `!` gesture:
 *
 *   /shell ls -la               run and show output; the model does NOT analyze
 *   /shell --analyze git diff   run, show output, then the model analyzes it
 *
 * A leading `-a`/`--analyze` (or `-d`/`--display`) token selects the mode; only
 * the FIRST token is interpreted, so `ls -a` is always the command `ls -a`.
 * Bare form falls back to `config.defaultMode`.
 *
 * Architecture:
 * - `ctx.commands.register` exposes `/shell` to the web GUI's `/` menu; the
 *   host executor logs `command/run`/`command/done`, which the UI renders as a
 *   persistent flow node (Mode 1 needs nothing else).
 * - Mode 2 additionally calls `agent.followup(createUserMessage(...))` so a new
 *   turn analyzes the transcript synchronously.
 *
 * @module dsh-shell-command
 */
import z from "@deepseek-ai/schemastery";
import { runCommand, resolveShell, PLATFORM_ARGS } from "./exec.js";
import { formatResult, formatSummary } from "./format.js";
import { createAnalysisMessage } from "./message.js";
import { parseLine, USAGE } from "./parse.js";
import { setupTerminalMode } from "./rpc.js";
import { agentCwd } from "./util.js";

export const name = "shell-command";

/**
 * Required services. `commands` powers the single-command mode; `connection`,
 * `agents`, and `webServer` power the multi-command terminal mode (RPC + PTY
 * WebSocket). Cordis loads all of them before `apply` runs, so `ctx.get(...)`
 * returns live services rather than `undefined`.
 */
export const inject = ["commands", "connection", "agents", "webServer"];

/** Fail-loud config contract; normalized through schemastery on load. */
const Config = z.object({
	shell: z.string().default(""),
	shellArgs: z.array(z.string()).default([]),
	timeoutMs: z.natural().min(1).default(60000),
	maxOutputBytes: z.natural().min(1).default(32768),
	graceMs: z.natural().min(1).default(3000),
	defaultMode: z.union(["display", "analyze"]).default("display"),
	analysisPrompt: z.string().default(""),
	// Multi-command terminal mode.
	terminalEnabled: z.boolean().default(true),
	terminalMaxTranscriptBytes: z.natural().min(1).default(1 << 20),
	terminalInjectMaxBytes: z.natural().min(1).default(32768),
	terminalTranscriptDir: z.string().default(".dsh-shell-transcripts"),
	terminalTranscriptKeep: z.natural().min(1).default(10),
});

/**
 * Cordis plugin entry: register the `/shell` command against every composed
 * command adapter. The handler runs on the host process, executes the command,
 * and (in analyze mode) wakes the model with the transcript.
 */
export function apply(ctx, rawConfig = {}) {
	const effective = Config(rawConfig);
	const shellArgs = effective.shellArgs.length > 0 ? effective.shellArgs : PLATFORM_ARGS;
	const subprocess = ctx.get("subprocess");

	// Multi-command terminal mode: interactive PTY popup + exit consent gate.
	// Best-effort; degrades to a no-op (with a warning) when node-pty/ws or the
	// required services are unavailable.
	if (effective.terminalEnabled) {
		ctx.effect(async () => {
			return await setupTerminalMode(ctx, effective);
		}, "shell-command terminal lifecycle");
	}

	ctx.effect(() => ctx.commands.register({
		name: "shell",
		description: "Run a shell command and show its output (use /terminal for an interactive session)",
		input: { hint: "[--analyze|-a | --display|-d] <command>" },
		handler: async (invocation) => {
			const parsed = parseLine(invocation.rawInput, effective.defaultMode);
			if (parsed.kind === "usage") return { kind: "error", text: USAGE };
			// Point a bare `/shell -t`/`--terminal` at the interactive command.
			if (parsed.command === "-t" || parsed.command === "--terminal") {
				return { kind: "error", text: "Interactive terminal is the separate /terminal command, not /shell." };
			}

			const cwd = agentCwd(invocation.agent);
			const shell = await resolveShell(effective.shell, subprocess, invocation.signal);

			const outcome = await runCommand({
				command: parsed.command,
				shell,
				shellArgs,
				cwd,
				timeoutMs: effective.timeoutMs,
				graceMs: effective.graceMs,
				maxOutputBytes: effective.maxOutputBytes,
				subprocess,
				signal: invocation.signal,
			});

			if (!outcome.ok) {
				return {
					kind: "error",
					text: `failed to run command: ${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`,
				};
			}

			const outputText = formatResult(outcome);

			if (parsed.mode === "analyze") {
				const message = createAnalysisMessage({
					command: parsed.command,
					cwd,
					outputText,
					summary: formatSummary(parsed.command),
					template: effective.analysisPrompt,
				});
				invocation.agent.followup(message);
			}

			return { kind: "success", text: outputText };
		},
	}), "shell-command lifecycle");
}

export { Config, parseLine, USAGE };
