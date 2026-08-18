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
	constructor(pty, streamId, cwd, maxTranscriptBytes) {
		this.pty = pty;
		this.streamId = streamId;
		this.cwd = cwd;
		this.maxTranscriptBytes = maxTranscriptBytes;
		this.transcript = "";
		this.transcriptTruncated = false;
		this.exited = false;
		this.exitCode = null;
		this.watchers = new Set();
		// True once any user-originated input frame is seen (WS message or the
		// write() fallback). A PTY prints its shell banner/prompt unprompted, so
		// `transcript` is never truly empty — this is the real "did the user do
		// anything" signal, used to skip persisting/surfacing no-op sessions.
		this.hasInput = false;

		this.pty.onData((data) => this.appendTranscript(data));
		this.pty.onExit(({ exitCode }) => {
			this.exited = true;
			this.exitCode = exitCode;
		});
	}

	/** Append to the bounded transcript and broadcast to every watcher. */
	appendTranscript(data) {
		this.transcript += data;
		const tail = tailTranscript(this.transcript, this.maxTranscriptBytes);
		this.transcript = tail.text;
		if (tail.truncated) this.transcriptTruncated = true;
		for (const ws of this.watchers) {
			if (ws.readyState === 1 /* OPEN */) ws.send(data);
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

		if (existing !== undefined) killQuiet(existing);
		const streamId = `term-${sessionId}`;
		const handle = new TerminalHandle(spawn(sessionId, cwd, cols, rows), streamId, cwd, maxTranscriptBytes);
		sessions.set(sessionId, handle);
		opening.delete(sessionId);
		return handle;
	}

	/** Resolve the live terminal for a session, or undefined. */
	function get(sessionId) {
		return sessions.get(sessionId);
	}

	/** Attach a WebSocket: replay the transcript, then stream bytes both ways. */
	function attachWs(sessionId, ws) {
		const handle = get(sessionId);
		if (handle === undefined) {
			ws.close(1011, "no terminal session");
			return;
		}
		handle.watchers.add(ws);
		if (handle.transcript !== "") ws.send(handle.transcript);
		ws.on("message", (data) => {
			handle.hasInput = true;
			try {
				handle.pty.write(data.toString("utf8"));
			} catch {
				// The PTY exited between the last frame and this write.
			}
		});
		ws.on("close", () => {
			handle.watchers.delete(ws);
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
		killQuiet(handle);
		return { transcript: handle.transcript, truncated: handle.transcriptTruncated, exitCode: handle.exitCode, hasInput: handle.hasInput };
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
			.filter((name) => name.startsWith(`${sessionId}-`) && name.endsWith(".log"))
			.sort()
			.reverse();
		return logs.map((name) => {
			const file = join(dir, name);
			const metaFile = join(dir, name.replace(/\.log$/, ".meta.json"));
			let meta;
			try {
				meta = JSON.parse(readFileSync(metaFile, "utf8"));
			} catch {
				meta = null;
			}
			const stat = statSync(file);
			return {
				path: file,
				name,
				bytes: stat.size,
				timestamp: meta?.timestamp ?? stat.mtime.toISOString(),
				exitCode: meta?.exitCode ?? null,
				truncated: meta?.truncated === true,
			};
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
				.filter((name) => name.startsWith(`${sessionId}-`) && name.endsWith(".log"))
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

	function killQuiet(handle) {
		try {
			handle.pty.kill();
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
	}

	function disposeAll() {
		for (const handle of sessions.values()) killQuiet(handle);
		sessions.clear();
	}

	return { open, get, attachWs, resize, write, close, persist, list, readTranscript, disposeAll };
}
