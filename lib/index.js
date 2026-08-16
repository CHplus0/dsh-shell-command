/**
 * dsh-shell-command — a `/!` command trigger for DeepSeek Harness.
 *
 * Runs a command in the receiving agent's session workspace and analyzes its
 * output, inspired by Claude Code's `!` gesture (DSH's input system only supports
 * `/` and `@` as trigger characters, so we use `/!` instead of bare `!`):
 *
 *   /! ls -la            run and analyze output
 *   /! git diff          run, show output, then the model analyzes it
 *
 * Architecture:
 * - Client-side `/!` input trigger (lib/client.js) via `inputTriggers.registerSource`
 * - Host RPC handler (`/shell-bang-rpc`) executes the command and calls `agent.followup`
 * - `/terminal` command remains separate for interactive multi-command sessions
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
 * Required services. `connection` powers the RPC bridge for the `!` trigger;
 * `agents` resolves session IDs to agents; `connection`, `agents`, and
 * `webServer` power the multi-command terminal mode (RPC + PTY WebSocket).
 * Cordis loads all of them before `apply` runs, so `ctx.get(...)` returns
 * live services rather than `undefined`.
 */
export const inject = ["connection", "agents", "webServer"];

/** Fail-loud config contract; normalized through schemastery on load. */
const Config = z.object({
	shell: z.string().default(""),
	shellArgs: z.array(z.string()).default([]),
	timeoutMs: z.natural().min(1).default(60000),
	maxOutputBytes: z.natural().min(1).default(32768),
	graceMs: z.natural().min(1).default(3000),
	analysisPrompt: z.string().default(""),
	// Multi-command terminal mode.
	terminalEnabled: z.boolean().default(true),
	terminalMaxTranscriptBytes: z.natural().min(1).default(1 << 20),
	terminalInjectMaxBytes: z.natural().min(1).default(32768),
	terminalTranscriptDir: z.string().default(".dsh-shell-transcripts"),
	terminalTranscriptKeep: z.natural().min(1).default(10),
});

/**
 * Cordis plugin entry: register the RPC handler for the `!` bang trigger.
 * The handler runs on the host process, executes the command, and wakes the
 * model with the transcript via `agent.followup`.
 */
export function apply(ctx, rawConfig = {}) {
	const effective = Config(rawConfig);
	const shellArgs = effective.shellArgs.length > 0 ? effective.shellArgs : PLATFORM_ARGS;
	const subprocess = ctx.get("subprocess");
	const connection = ctx.get("connection");
	const agents = ctx.get("agents");

	// Multi-command terminal mode: interactive PTY popup + exit consent gate.
	// Best-effort; degrades to a no-op (with a warning) when node-pty/ws or the
	// required services are unavailable.
	if (effective.terminalEnabled) {
		ctx.effect(async () => {
			return await setupTerminalMode(ctx, effective);
		}, "shell-command terminal lifecycle");
	}

	// RPC handler for the `!` bang trigger.
	if (connection !== undefined && agents !== undefined) {
		ctx.effect(() => connection.rpc.handle("/shell-bang-rpc", async (endpoint, payload, signal) => {
			if (endpoint !== "run") {
				return { ok: false, error: { code: "bad-request", message: `unknown endpoint: ${String(endpoint)}`, details: { issues: [] } } };
			}

			const agent = typeof payload?.sessionId === "string" ? agents.get(payload.sessionId) : undefined;
			if (agent === undefined) {
				return { ok: false, error: { code: "session-not-found", message: `no live agent owns session "${String(payload?.sessionId)}"`, details: { issues: [] } } };
			}

			const parsed = parseLine(String(payload?.command || ""));
			if (parsed.kind === "usage") {
				return { ok: false, error: { code: "bad-request", message: USAGE, details: { issues: [] } } };
			}

			const cwd = agentCwd(agent);
			const shell = await resolveShell(effective.shell, subprocess, signal);

			const outcome = await runCommand({
				command: parsed.command,
				shell,
				shellArgs,
				cwd,
				timeoutMs: effective.timeoutMs,
				graceMs: effective.graceMs,
				maxOutputBytes: effective.maxOutputBytes,
				subprocess,
				signal,
			});

			if (!outcome.ok) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
						details: { issues: [] },
					},
				};
			}

			const outputText = formatResult(outcome);
			const message = createAnalysisMessage({
				command: parsed.command,
				cwd,
				outputText,
				summary: formatSummary(parsed.command),
				template: effective.analysisPrompt,
			});
			agent.followup(message);

			return { ok: true, value: {} };
		}, { authority: "trusted-host" }), "shell-command bang RPC");
	}
}

export { Config, parseLine, USAGE };
