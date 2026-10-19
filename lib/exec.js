/**
 * dsh-shell-command — command execution engine.
 *
 * Two backends, one normalized outcome:
 *
 * 1. `ctx.subprocess` (the harness's managed subprocess seam, when present):
 *    scrubbed environment, tree-scoped SIGTERM→grace→SIGKILL termination, and
 *    bounded tail-retaining output collection. This is the same seam the
 *    official bash/pwsh tools use.
 * 2. `node:child_process` fallback: scrubbed environment (via the exported
 *    `scrubbedParentEnv`), bounded in-memory buffers, and process-group
 *    termination on abort. Used only when the seam is unavailable in the profile.
 *
 * Timeout and cancellation are classified from the caller-owned signals, never
 * guessed from the exit facts.
 *
 * @module dsh-shell-command/exec
 */
import { spawn as spawnChild } from "node:child_process";
import { isAbsolute } from "node:path";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";

/** Platform default shell program (an absolute POSIX path; a PATH name on Windows). */
export const PLATFORM_SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/bash";

/** Platform default shell arguments (POSIX login-interactive-command shape). */
export const PLATFORM_ARGS = process.platform === "win32" ? ["/d", "/s", "/c"] : ["-lc"];

/**
 * Run one command and return a normalized outcome. Never throws for expected
 * runtime failures (spawn, timeout, cancellation); a rejected promise means a
 * programming error.
 *
 * @param input - command, execution context, and limits.
 * @param input.command - the verbatim command line handed to the shell.
 * @param input.shell - executable (ideally absolute) that runs the command.
 * @param input.shellArgs - argv tail before the command string.
 * @param input.cwd - child working directory.
 * @param input.timeoutMs - hard deadline for the whole command.
 * @param input.graceMs - SIGTERM→SIGKILL escalation window (subprocess backend).
 * @param input.maxOutputBytes - per-stream in-memory cap (tail retained).
 * @param input.subprocess - optional `ctx.subprocess` service; fallback when absent.
 * @param input.signal - caller cancellation signal (the UI request's).
 * @returns normalized outcome.
 */
export async function runCommand(input) {
	const {
		command,
		shell,
		shellArgs,
		cwd,
		timeoutMs,
		graceMs,
		maxOutputBytes,
		subprocess,
		signal = new AbortController().signal,
	} = input;

	const timeoutSignal = AbortSignal.timeout(timeoutMs);
	const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
	const argv = [shell, ...shellArgs, command];

	const outcome = subprocess !== undefined
		? await runViaSubprocess({ argv, cwd, graceMs, maxOutputBytes, subprocess, combinedSignal })
		: await runViaChildProcess({ argv, cwd, graceMs, maxOutputBytes, combinedSignal });

	return {
		...outcome,
		command,
		timeoutMs,
		timedOut: timeoutSignal.aborted,
		cancelled: signal.aborted,
	};
}

/** Managed subprocess backend: tree-scoped termination and tail-retaining collect. */
async function runViaSubprocess({ argv, cwd, graceMs, maxOutputBytes, subprocess, combinedSignal }) {
	let handle;
	try {
		handle = subprocess.spawn({
			argv,
			cwd,
			graceMs,
			signal: combinedSignal,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: maxOutputBytes },
				stderr: { maxBytes: maxOutputBytes },
			},
		});
	} catch (error) {
		return { ok: false, error };
	}

	let outcome;
	try {
		outcome = await handle.done;
	} catch (error) {
		// `done` rejects only for spawn-level failures.
		return { ok: false, error };
	}

	return {
		ok: true,
		stdout: readCollected(handle.collected.stdout),
		stderr: readCollected(handle.collected.stderr),
		exitCode: outcome.exitCode,
		signal: outcome.signal,
	};
}

/** Read one collect-mode stream after settlement; `readFrom(0)` is the batch tail. */
function readCollected(reader) {
	if (reader === undefined) return { text: "", truncated: false };
	const read = reader.readFrom(0);
	return { text: read.text, truncated: read.lossy };
}

/** child_process fallback: isolated process group and TERM → grace → KILL. */
function runViaChildProcess({ argv, cwd, graceMs, maxOutputBytes, combinedSignal }) {
	return new Promise((resolve) => {
		if (combinedSignal.aborted) {
			resolve({ ok: true, stdout: { text: "", truncated: false }, stderr: { text: "", truncated: false }, exitCode: null, signal: "SIGTERM" });
			return;
		}
		let child;
		try {
			child = spawnChild(argv[0], argv.slice(1), {
				cwd,
				env: scrubbedParentEnv(),
				stdio: ["ignore", "pipe", "pipe"],
				detached: process.platform !== "win32",
			});
		} catch (error) {
			resolve({ ok: false, error });
			return;
		}

		const stdout = bounded();
		const stderr = bounded();
		let killTimer, drainTimer, closeFacts;
		let terminating = false;
		const groupAlive = () => {
			if (!child.pid || process.platform === "win32") return false;
			try { process.kill(-child.pid, 0); return true; } catch { return false; }
		};
		const kill = (signal) => {
			if (!child.pid) return;
			if (process.platform === "win32") {
				// taskkill is an OS utility; use argv, never a shell command string.
				const task = spawnChild("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
				task.on("error", () => { try { child.kill("SIGKILL"); } catch { /* exited */ } });
			} else {
				try { process.kill(-child.pid, signal); } catch { /* process group exited */ }
			}
		};
		const finish = (outcome) => {
			clearTimeout(killTimer);
			clearTimeout(drainTimer);
			combinedSignal.removeEventListener("abort", terminate);
			resolve(outcome);
		};
		const terminate = () => {
			if (terminating) return;
			terminating = true;
			kill("SIGTERM");
			killTimer = setTimeout(() => {
				kill("SIGKILL");
				killTimer = undefined;
				if (closeFacts) finish(closeFacts);
				else {
					// An escaped descendant may still hold a pipe. Bound the drain.
					drainTimer = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, graceMs);
				}
			}, graceMs);
		};
		child.stdout.on("data", (chunk) => stdout.push(chunk, maxOutputBytes));
		child.stderr.on("data", (chunk) => stderr.push(chunk, maxOutputBytes));
		child.on("error", (error) => {
			finish({ ok: false, error });
		});
		child.on("close", (exitCode, signal) => {
			closeFacts = {
				ok: true,
				stdout: stdout.result(),
				stderr: stderr.result(),
				exitCode,
				signal: signal ?? null,
			};
			// Do not cancel escalation merely because the root exited: an ignoring
			// descendant with redirected stdio can still be alive in its group.
			if (!terminating || !killTimer || !groupAlive()) finish(closeFacts);
		});
		combinedSignal.addEventListener("abort", terminate, { once: true });
		if (combinedSignal.aborted) terminate();
	});
}

/** Tail-retaining byte buffer for the child_process fallback. */
function bounded() {
	let buffer = Buffer.alloc(0);
	let truncated = false;
	return {
		push(chunk, maxBytes) {
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > maxBytes) {
				buffer = buffer.subarray(buffer.length - maxBytes);
				truncated = true;
			}
		},
		result() {
			let start = 0;
			if (truncated) while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
			return { text: buffer.subarray(start).toString("utf8"), truncated };
		},
	};
}

/**
 * Resolve the configured shell to an executable path when `ctx.subprocess` is
 * available (its `resolveExecutable` verifies absolute paths and searches the
 * scrubbed PATH for bare names). Without the seam, absolute paths pass through
 * and bare names are handed to `spawn` as-is (PATH lookup by the OS).
 */
export async function resolveShell(shell, subprocess, signal) {
	const candidate = shell === "" ? PLATFORM_SHELL : shell;
	if (subprocess === undefined || isAbsolute(candidate)) return candidate;
	try {
		return await subprocess.resolveExecutable(candidate, {}, signal);
	} catch {
		return candidate;
	}
}
