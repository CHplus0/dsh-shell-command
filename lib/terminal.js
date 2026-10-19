/**
 * dsh-shell-command — interactive terminal registry (multi-command mode).
 *
 * One persistent PTY per session, owner-scoped, with a bounded in-memory
 * transcript (the source for both WebSocket replay and exit-time persistence).
 * The PTY implementation is injectable so unit tests run against a stub; the
 * host wires `node-pty` (the same native backend dsh-better-sidebar uses).
 *
 * @module dsh-shell-command/terminal
 */
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import { tailTranscript } from "./inject.js";
import { PLATFORM_SHELL } from "./exec.js";
import { clampDim } from "./util.js";

/**
 * Platform default shell. Windows shares the single-command mode's default
 * (`PLATFORM_SHELL`, cmd.exe) so the two modes agree when unconfigured; POSIX
 * honors the user's actual login shell (`$SHELL`), which is the right default
 * for an interactive terminal even though single-command mode intentionally
 * pins a fixed `/bin/bash` for determinism.
 */
export function defaultShell() {
	if (process.platform === "win32") return PLATFORM_SHELL;
	const shell = process.env.SHELL;
	return shell !== undefined && shell.trim() !== "" ? shell : PLATFORM_SHELL;
}

/**
 * A live terminal handle: the PTY process, its bounded transcript, and the
 * WebSocket watchers streaming its output.
 */
class TerminalHandle {
	constructor(pty, streamId, cwd, maxTranscriptBytes, onExit) {
		this.pty = pty;
		this.streamId = streamId;
		this.cwd = cwd;
		this.maxTranscriptBytes = maxTranscriptBytes;
		this.transcript = "";
		this.transcriptTruncated = false;
		this.exited = false;
		this.exitCode = null;
		this.closing = false;
		this.transcriptPath = null;
		this.done = new Promise((resolve) => { this.resolveExit = resolve; });
		this.watchers = new Set();
		this.structuredWatchers = new Set();
		// True after an activity marker, legacy raw input, or write(). Structured
		// input can be an automatic reply. A PTY prints its prompt unprompted, so
		// `transcript` is never truly empty — this is the real "did the user do
		// anything" signal, used to skip persisting/surfacing no-op sessions.
		this.hasInput = false;

		this.pty.onData((data) => this.appendTranscript(data));
		this.pty.onExit(({ exitCode }) => {
			this.exited = true;
			this.exitCode = exitCode;
			this.resolveExit();
			// Save before notifying clients. Natural exit must also be durable
			// when no browser is connected to request a close RPC.
			if (!this.closing) onExit(this);
			for (const ws of this.structuredWatchers) {
				if (ws.readyState === 1) ws.send(JSON.stringify({ type: "exit", exitCode }));
			}
		});
	}

	/** Append to the bounded transcript and broadcast to every watcher. */
	appendTranscript(data) {
		this.transcript += data;
		const tail = tailTranscript(this.transcript, this.maxTranscriptBytes);
		this.transcript = tail.text;
		if (tail.truncated) this.transcriptTruncated = true;
		for (const ws of this.watchers) {
			if (ws.readyState === 1 /* OPEN */) ws.send(this.structuredWatchers.has(ws)
				? JSON.stringify({ type: "output", data }) : data);
		}
	}
}

/**
 * Owner-scoped terminal registry. Exactly one live terminal per session in v1
 * (reopening reuses the live PTY, or respawns one if the process exited).
 *
 * @param deps.pty - the PTY spawner (`node-pty`), injectable for tests.
 * @param deps.shell - shell executable.
 * @param deps.maxTranscriptBytes - in-memory transcript cap (tail retained).
 * @param deps.transcriptDir - workspace-relative persistence directory name.
 * @param deps.transcriptKeep - max persisted transcript files per session.
 * @param deps.logger - cordis logger for non-fatal warnings.
 */
export function createTerminalManager(deps) {
	const {
		pty,
		shell = defaultShell(),
		maxTranscriptBytes = 1 << 20,
		transcriptDir = ".dsh-shell-transcripts",
		transcriptKeep = 10,
		graceMs = 3000,
		logger = { warn: () => {} },
	} = deps;

	const sessions = new Map(); // sessionId -> TerminalHandle | "opening"
	const opening = new Set(); // sessionId -> guard against concurrent spawn
	let persistCounter = 0; // disambiguates two persists landing in the same millisecond

	function spawn(sessionId, cwd, cols, rows) {
		return pty.spawn(shell, [], {
			name: "xterm-256color",
			cols: clampDim(cols, 80),
			rows: clampDim(rows, 24),
			cwd,
			env: scrubbedParentEnv(),
		});
	}

	/** Open (or reuse) the terminal for one session. */
	function open(sessionId, { cwd, cols, rows }) {
		const existing = sessions.get(sessionId);
		if (existing !== undefined && !existing.exited && existing.cwd === cwd) return existing;

		// Guard against concurrent open() racing to spawn multiple PTYs.
		if (opening.has(sessionId)) {
			logger.warn?.(`dsh-shell-command: concurrent open for session ${sessionId} ignored`);
			return existing ?? { streamId: `term-${sessionId}`, cwd, transcript: "", exited: true };
		}
		opening.add(sessionId);

		try {
			if (existing !== undefined) {
				existing.closing = true;
				killQuiet(existing);
				saveHandle(sessionId, existing);
			}
			sessions.delete(sessionId);
			const streamId = `term-${sessionId}-${randomUUID()}`;
			const handle = new TerminalHandle(spawn(sessionId, cwd, cols, rows), streamId, cwd, maxTranscriptBytes,
				(ended) => {
					try { saveHandle(sessionId, ended); }
					catch (error) { logger.warn?.(`dsh-shell-command: transcript persist failed: ${error?.message ?? error}`); }
				});
			sessions.set(sessionId, handle);
			return handle;
		} finally {
			opening.delete(sessionId);
		}
	}

	/** Resolve the live terminal for a session, or undefined. */
	function get(sessionId) {
		return sessions.get(sessionId);
	}

	/** Attach a WebSocket: replay the transcript, then stream bytes both ways. */
	function attachWs(sessionId, ws, { structured = false, streamId } = {}) {
		const handle = get(sessionId);
		if (handle === undefined || (streamId !== undefined && streamId !== handle.streamId)) {
			ws.close(1011, "no terminal session");
			return;
		}
		const detach = () => {
			handle.watchers.delete(ws);
			handle.structuredWatchers.delete(ws);
		};
		// Protocol/transport errors are emitted by ws, outside the JSON handler.
		// They must not become an unhandled EventEmitter error in the host.
		ws.on("error", detach);
		ws.on("close", detach);
		handle.watchers.add(ws);
		if (structured) handle.structuredWatchers.add(ws);
		if (handle.transcript !== "") ws.send(structured
			? JSON.stringify({ type: "output", data: handle.transcript }) : handle.transcript);
		if (structured && handle.exited) ws.send(JSON.stringify({ type: "exit", exitCode: handle.exitCode }));
		ws.on("message", (data) => {
			if (handle.exited || handle.closing || !handle.watchers.has(ws) || get(sessionId) !== handle) return;
			let input = data.toString("utf8");
			if (structured) {
				let message;
				try { message = JSON.parse(input); } catch { return; }
				if (message?.type === "activity") {
					handle.hasInput = true;
					return;
				}
				if (message?.type === "binary" && Array.isArray(message.data)
					&& message.data.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
					try { handle.pty.write(Buffer.from(message.data)); } catch { /* exited */ }
					return;
				}
				if (message?.type !== "input" || typeof message.data !== "string") return;
				input = message.data;
			} else if (input !== "") {
				handle.hasInput = true;
			}
			try {
				handle.pty.write(input);
			} catch {
				// The PTY exited between the last frame and this write.
			}
		});
	}

	function resize(sessionId, cols, rows) {
		const handle = get(sessionId);
		if (handle === undefined || handle.exited) return;
		handle.pty.resize(clampDim(cols, 80), clampDim(rows, 24));
	}

	/** Write input directly (non-WebSocket fallback). */
	function write(sessionId, data) {
		const handle = get(sessionId);
		if (handle === undefined || handle.exited) return;
		handle.hasInput = true;
		handle.pty.write(data);
	}

	/** Close the terminal and return its transcript (does not persist). */
	function close(sessionId) {
		const handle = sessions.get(sessionId);
		if (handle === undefined) return { transcript: "", truncated: false, exitCode: null, hasInput: false };
		sessions.delete(sessionId);
		handle.closing = true;
		killQuiet(handle);
		return { transcript: handle.transcript, truncated: handle.transcriptTruncated, exitCode: handle.exitCode,
			hasInput: handle.hasInput, cwd: handle.cwd, transcriptPath: handle.transcriptPath };
	}

	function saveHandle(sessionId, handle) {
		if (!handle.hasInput || handle.transcriptPath) return;
		handle.transcriptPath = persist(handle.cwd, sessionId, handle.transcript,
			{ exitCode: handle.exitCode, truncated: handle.transcriptTruncated });
	}

	/** Drain exit output before persisting; failed writes remain retryable. */
	async function finish(sessionId) {
		const handle = get(sessionId);
		if (!handle) return { transcriptPath: null, bytes: 0, exitCode: null };
		if (handle.finishing) return handle.finishing;
		handle.finishing = (async () => {
			handle.closing = true;
			killQuiet(handle);
			const waitForExit = async () => {
				let timer;
				try {
					return await Promise.race([handle.done.then(() => true),
						new Promise(resolve => { timer = setTimeout(() => resolve(false), graceMs); })]);
				} finally { clearTimeout(timer); }
			};
			if (!handle.exited && !await waitForExit()) {
				try { handle.pty.kill("SIGKILL"); } catch { /* exit may be in flight */ }
				if (!await waitForExit()) throw new Error("Terminal did not exit after SIGKILL");
			}
			saveHandle(sessionId, handle);
			if (get(sessionId) === handle) sessions.delete(sessionId);
			return { transcriptPath: handle.transcriptPath,
				bytes: handle.hasInput ? Buffer.byteLength(handle.transcript, "utf8") : 0, exitCode: handle.exitCode };
		})();
		try { return await handle.finishing; }
		finally { handle.finishing = null; }
	}

	/**
	 * Persist a transcript to the session workspace, plus a `.meta.json` sidecar
	 * (exit code / truncation) that backs the history list. Only ever called
	 * for sessions that actually received input (see `hasInput`) — the caller
	 * is expected to skip persisting empty sessions entirely. Returns the
	 * transcript file path.
	 */
	function persist(cwd, sessionId, transcript, meta = {}) {
		const dir = join(cwd, transcriptDir);
		mkdirSync(dir, { recursive: true });
		const stamp = new Date().toISOString().replace(/[:.]/g, "-");
		// The counter suffix disambiguates two closes landing in the same
		// millisecond, which would otherwise collide on filename and silently
		// overwrite each other (both the transcript and its meta sidecar).
		// Zero-padded so lexicographic filename sort (used by list()/prune())
		// agrees with persist order past the 10th collision in one millisecond.
		const base = `${sessionId}-${stamp}-${String(persistCounter++).padStart(6, "0")}`;
		const file = join(dir, `${base}.log`);
		writeFileSync(file, transcript, "utf8");
		try {
			writeFileSync(join(dir, `${base}.meta.json`), JSON.stringify({
				timestamp: new Date().toISOString(),
				exitCode: meta.exitCode ?? null,
				truncated: meta.truncated === true,
			}), "utf8");
		} catch {
			// Sidecar is best-effort; the transcript itself is the source of truth.
		}
		prune(dir, sessionId);
		return file;
	}

	/**
	 * List persisted transcripts for one session, newest first. Tolerates logs
	 * with no `.meta.json` sidecar (pre-existing files from before history mode
	 * shipped) by falling back to file stat + `exitCode: null`.
	 */
	function list(cwd, sessionId) {
		const dir = join(cwd, transcriptDir);
		let names;
		try {
			names = readdirSync(dir);
		} catch {
			return [];
		}
		const logs = names
			.filter((name) => ownsLog(name, sessionId))
			.sort()
			.reverse();
		return logs.flatMap((name) => {
			const file = join(dir, name);
			const metaFile = join(dir, name.replace(/\.log$/, ".meta.json"));
			let meta;
			try {
				meta = JSON.parse(readFileSync(metaFile, "utf8"));
			} catch {
				meta = null;
			}
			let stat;
			try { stat = statSync(file); } catch { return []; }
			if (!stat.isFile()) return [];
			return [{
				path: file,
				name,
				bytes: stat.size,
				timestamp: meta?.timestamp ?? stat.mtime.toISOString(),
				exitCode: meta?.exitCode ?? null,
				truncated: meta?.truncated === true,
			}];
		});
	}

	/** Read one persisted transcript's text (bounded by the caller if needed). */
	function readTranscript(path) {
		return readFileSync(path, "utf8");
	}

	/** Keep only the newest `transcriptKeep` files (+ sidecars) for one session id. */
	function prune(dir, sessionId) {
		try {
			const files = readdirSync(dir)
				.filter((name) => ownsLog(name, sessionId))
				.sort()
				.reverse();
			for (const name of files.slice(transcriptKeep)) {
				try {
					rmSync(join(dir, name), { force: true });
					rmSync(join(dir, name.replace(/\.log$/, ".meta.json")), { force: true });
				} catch {
					// Best-effort prune; a locked file is not fatal.
				}
			}
		} catch {
			// Directory missing/unreadable; nothing to prune.
		}
	}

	function ownsLog(name, sessionId) {
		// A prefix check alone lets owner "a" see/prune owner "a-b"'s logs.
		return name.startsWith(`${sessionId}-`)
			&& /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z(?:-\d+)?\.log$/.test(name.slice(sessionId.length + 1));
	}

	function killQuiet(handle) {
		try {
			if (!handle.exited) handle.pty.kill();
		} catch {
			// Already dead; ignore.
		}
		for (const ws of handle.watchers) {
			try {
				ws.close();
			} catch {
				// Ignore.
			}
		}
		handle.watchers.clear();
		handle.structuredWatchers.clear();
	}

	function disposeAll() {
		for (const handle of sessions.values()) killQuiet(handle);
		sessions.clear();
	}

	return { open, get, attachWs, resize, write, close, finish, persist, list, readTranscript, disposeAll };
}
