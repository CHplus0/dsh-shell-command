// Standalone smoke test for the multi-command terminal mode (host side only):
// terminal registry with a stub PTY, inject message construction, and the
// close-consent RPC flow against a mock connection/agents context.
//
// Requires the @deepseek-ai/* peer packages to resolve from this checkout
// (see test/smoke.mjs for the one-time link step).
//
//   node test/smoke-terminal.mjs
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createTerminalManager } from "../lib/terminal.js";
import { buildFollowupMessage, buildPointerMessage, tailTranscript, stripAnsi } from "../lib/inject.js";
import { registerTerminalRpc } from "../lib/rpc.js";

const cwd = mkdtempSync(join(tmpdir(), "shell-term-smoke-"));

// ---- stub PTY ----
function makeStubPty() {
	let onData;
	let onExit;
	const instance = {
		onData(cb) { onData = cb; },
		onExit(cb) { onExit = cb; },
		write(data) { onData?.(data); },
		resize() {},
		kill() { onExit?.({ exitCode: 0 }); },
		emit(data) { onData?.(data); },
	};
	return instance;
}

// ---- terminal manager ----
const manager = createTerminalManager({
	pty: { spawn: () => makeStubPty() },
	shell: "/bin/bash",
	maxTranscriptBytes: 1024,
	transcriptDir: ".dsh-shell-transcripts",
	transcriptKeep: 3,
});

const handle = manager.open("sess-1", { cwd, cols: 80, rows: 24 });
assert.ok(handle.streamId, "open returns a streamId");
manager.write("sess-1", "echo hi\n");
manager.write("sess-1", "echo bye\n");
assert.match(manager.get("sess-1").transcript, /echo hi/);
assert.match(manager.get("sess-1").transcript, /echo bye/);

const closed = manager.close("sess-1");
assert.match(closed.transcript, /echo hi/);
assert.equal(closed.exitCode, 0);

// persist
const path = manager.persist(cwd, "sess-1", closed.transcript);
assert.ok(existsSync(path), "transcript file persisted");
assert.match(readFileSync(path, "utf8"), /echo hi/);

// ---- inject message construction ----
const followup = buildFollowupMessage({
	cwd,
	command: "terminal session",
	transcript: "\x1b[31mred\x1b[0m output\n",
	truncated: false,
	exitCode: 0,
	notes: "请重点看第一行",
	injectMaxBytes: 1024,
});
assert.equal(followup.role, "user");
assert.equal(followup.source.kind, "plugin");
assert.match(followup.content[0].text, /用户补充说明：请重点看第一行/);
assert.doesNotMatch(followup.content[0].text, /\x1b\[31m/, "ANSI stripped from followup");

const pointer = buildPointerMessage({ cwd, transcriptPath: path, bytes: 42 });
assert.equal(pointer.role, "user");
assert.match(pointer.content[0].text, new RegExp(path.replace(/[/\\]/g, ".")));

// pure helpers
assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
assert.equal(tailTranscript("0123456789", 5).truncated, true);

// ---- close-consent RPC flow ----
let rpcHandler;
const connection = {
	rpc: { handle(_channel, handler, _opts) { rpcHandler = handler; return () => {}; } },
};
const followups = [];
const injects = [];
const mockAgent = {
	id: "sess-2",
	session: { header: { cwd } },
	followup(msg) { followups.push(msg); },
	inject(msg) { injects.push(msg); },
};
const agents = { get: (id) => (id === "sess-2" ? mockAgent : undefined) };

registerTerminalRpc({ manager, agents, connection, config: { terminalInjectMaxBytes: 1024, logger: { warn: () => {} } } });
assert.ok(rpcHandler, "rpc handler registered");

// open
const openRes = await rpcHandler("open", { sessionId: "sess-2", cols: 100, rows: 30 });
assert.equal(openRes.ok, true);
manager.write("sess-2", "ls -la\n");

// close with inject=yes + notes
const closeYes = await rpcHandler("close", { sessionId: "sess-2", inject: true, notes: "看一下权限" });
assert.equal(closeYes.ok, true);
assert.equal(followups.length, 1, "followup fired once for yes");
assert.match(followups[0].content[0].text, /ls -la/);
assert.match(followups[0].content[0].text, /看一下权限/);
assert.equal(injects.length, 0);

// reopen + close with inject=no
await rpcHandler("open", { sessionId: "sess-2", cols: 80, rows: 24 });
manager.write("sess-2", "pwd\n");
const closeNo = await rpcHandler("close", { sessionId: "sess-2", inject: false });
assert.equal(closeNo.ok, true);
assert.equal(injects.length, 1, "pointer injected for no");
assert.match(injects[0].content[0].text, /转录已保存/);

// unknown session
const missing = await rpcHandler("open", { sessionId: "nope" });
assert.equal(missing.ok, false);
assert.equal(missing.error.code, "session-not-found");

rmSync(cwd, { recursive: true, force: true });
console.log("SMOKE-TERMINAL TEST DONE");
