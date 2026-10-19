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
import { randomUUID } from "node:crypto";
import { runCommand, resolveShell, PLATFORM_ARGS } from "./exec.js";
import { formatResult, formatSummary } from "./format.js";
import { createAnalysisMessage } from "./message.js";
import { parseLine, USAGE } from "./parse.js";
import { setupTerminalMode } from "./rpc.js";
import { agentCwd } from "./util.js";

export const name = "shell-command";

/**
 * Required services. `connection` powers the RPC bridge for the `!` trigger;
 * `agents` resolves session IDs to agents. `webServer` powers only the
 * optional terminal mode and must not gate /!.
 */
export const inject = ["connection", "agents"];

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

	// Multi-command terminal mode: xterm PTY popup with explicit history reference.
	// Best-effort; degrades to a no-op (with a warning) when node-pty/ws or the
	// required services are unavailable.
	if (effective.terminalEnabled) {
		// Bind only this child lifecycle to the optional service. If webServer
		// arrives late (or reloads), terminal mode starts without suspending /!.
		if (typeof ctx.inject === "function") {
			ctx.inject(["webServer"], terminalCtx => setupTerminalMode(terminalCtx, effective));
		} else {
			ctx.effect(() => setupTerminalMode(ctx, effective), "shell-command terminal lifecycle");
		}
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
			if (agent.session.requestHeader?.() === undefined) {
				return { ok: false, error: { code: "bad-request", message: "No model request exists yet. Send a message before using /! commands.", details: { issues: [] } } };
			}

			const parsed = parseLine(String(payload?.command || ""));
			if (parsed.kind === "usage") {
				return { ok: false, error: { code: "bad-request", message: USAGE, details: { issues: [] } } };
			}

			const commandId = `shell-${randomUUID()}`;
			let started = false;
			let settled = false;
			try {
				if (signal?.aborted) throw signal.reason ?? new Error("Command cancelled");
				agent.session.append("command/run", { commandId, name: "!", args: parsed.command, source: { kind: "user" } });
				started = true;
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
					throw outcome.error;
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
				agent.session.append("command/done", { commandId,
					kind: outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled ? "success" : "error", text: outputText });
				settled = true;

				return { ok: true, value: {} };
			} catch (error) {
				const text = error instanceof Error ? error.message : String(error);
				if (started && !settled) {
					try { agent.session.append("command/done", { commandId, kind: "error", text }); }
					catch (appendError) { ctx.logger?.warn?.(`dsh-shell-command: command audit failed: ${appendError?.message ?? appendError}`); }
				}
				return { ok: false, error: { code: "internal", message: text, details: { issues: [] } } };
			}
		}, { authority: "trusted-host" }), "shell-command bang RPC");
	}
}

export { Config, parseLine, USAGE };
