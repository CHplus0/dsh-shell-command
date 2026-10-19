// Standalone smoke test for the multi-command terminal mode (host side only):
// terminal registry with a stub PTY (including `hasInput` tracking for the
// empty-session skip), history-reference message construction, and the
// close / history RPC flow against a mock connection/agents context.
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
import { buildHistoryNotesMessage, tailTranscript, stripAnsi } from "../lib/inject.js";
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
assert.equal(closed.hasInput, true, "write() marks hasInput");

// persist
const path = manager.persist(cwd, "sess-1", closed.transcript);
assert.ok(existsSync(path), "transcript file persisted");
assert.match(readFileSync(path, "utf8"), /echo hi/);

// ---- empty session: PTY-originated output (shell banner) alone does not
// count as input — this is the actual signal a "no commands run" close skips
// persisting/injecting anything for (the bug this test guards against: a
// shell always prints a prompt unprompted, so transcript emptiness alone
// can't distinguish "opened and immediately closed" from "actually used").
const emptyHandle = manager.open("sess-1b", { cwd, cols: 80, rows: 24 });
emptyHandle.pty.emit("bash-5.2$ ");
const closedEmpty = manager.close("sess-1b");
assert.notEqual(closedEmpty.transcript, "", "shell banner produced non-empty transcript");
assert.equal(closedEmpty.hasInput, false, "no input was ever sent");

// ---- production input path: attachWs's WS message handler (not the write()
// fallback above) is what actually marks hasInput in the browser.
manager.open("sess-1c", { cwd, cols: 80, rows: 24 });
let wsMessageHandler;
const fakeWs = {
	on(event, cb) { if (event === "message") wsMessageHandler = cb; },
	readyState: 1,
	send() {},
	close() {},
};
manager.attachWs("sess-1c", fakeWs);
assert.equal(manager.get("sess-1c").hasInput, false, "no input yet");
wsMessageHandler(Buffer.from("ls\n"));
assert.equal(manager.get("sess-1c").hasInput, true, "attachWs message marks hasInput");
manager.close("sess-1c");

// ---- history-reference message construction ----
const historyNotesDefault = buildHistoryNotesMessage(undefined);
assert.equal(historyNotesDefault.source.kind, "user");
assert.match(historyNotesDefault.content[0].text, /请帮我分别分析这些历史终端记录/);

// pure helpers
assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
assert.equal(stripAnsi("\x1b]0;first\x1b\\visible text\x1b]0;second\x1b\\"), "visible text", "OSC title changes cannot swallow intervening output");
assert.equal(tailTranscript("0123456789", 5).truncated, true);

// ---- close / history RPC flow ----
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

registerTerminalRpc({ manager, agents, connection, logger: { warn: () => {} } });
assert.ok(rpcHandler, "rpc handler registered");

// open, then close without ever sending input — this is the exact scenario
// from the bug report: closing must leave zero trace and never touch the
// model, regardless of anything the client might have sent as `inject`/
// `notes` (those fields no longer exist in the close payload at all).
const openRes = await rpcHandler("open", { sessionId: "sess-2", cols: 100, rows: 30 });
assert.equal(openRes.ok, true);
const closeEmpty = await rpcHandler("close", { sessionId: "sess-2" });
assert.equal(closeEmpty.ok, true);
assert.equal(closeEmpty.value.transcriptPath, null, "empty session is not persisted");
assert.equal(followups.length, 0, "empty close never wakes the model");
assert.equal(injects.length, 0, "empty close never queues anything");
assert.equal(manager.list(cwd, "sess-2").length, 0, "empty session does not appear in history");

// reopen + close with real input: persisted, but closing itself is still
// completely silent — no agent.inject/followup, ever.
await rpcHandler("open", { sessionId: "sess-2", cols: 100, rows: 30 });
manager.write("sess-2", "ls -la\n");
const closeFirst = await rpcHandler("close", { sessionId: "sess-2" });
assert.equal(closeFirst.ok, true);
assert.notEqual(closeFirst.value.transcriptPath, null, "non-empty session is persisted");
assert.ok(existsSync(closeFirst.value.transcriptPath));
assert.equal(followups.length, 0, "close never wakes the model, even for a non-empty session");
assert.equal(injects.length, 0, "close never queues anything, even for a non-empty session");
assert.equal(manager.list(cwd, "sess-2").length, 1);

// a second non-empty close, for the multi-select history-reference test below.
await rpcHandler("open", { sessionId: "sess-2", cols: 80, rows: 24 });
manager.write("sess-2", "pwd\n");
const closeSecond = await rpcHandler("close", { sessionId: "sess-2" });
assert.equal(closeSecond.ok, true);
assert.notEqual(closeSecond.value.transcriptPath, null);
assert.equal(followups.length, 0);
assert.equal(injects.length, 0);
assert.equal(manager.list(cwd, "sess-2").length, 2);

// unknown session
const missing = await rpcHandler("open", { sessionId: "nope" });
assert.equal(missing.ok, false);
assert.equal(missing.error.code, "session-not-found");

// ---- history tab: list / read / reference-inject ----
const historyListRes = await rpcHandler("historyList", { sessionId: "sess-2" });
assert.equal(historyListRes.ok, true);
assert.equal(historyListRes.value.entries.length, 2, "two persisted transcripts for sess-2");
const [newest, older] = historyListRes.value.entries;
assert.ok(newest.timestamp >= older.timestamp, "newest first");

const historyReadRes = await rpcHandler("historyRead", { sessionId: "sess-2", path: older.path });
assert.equal(historyReadRes.ok, true);
assert.match(historyReadRes.value.transcript, /ls -la/);

const historyReadBad = await rpcHandler("historyRead", { sessionId: "sess-2", path: "/etc/passwd" });
assert.equal(historyReadBad.ok, false, "path not owned by this session is rejected");

// historyInject also splits, and wakes the model (notes via inject, pointer
// via followup) — this is the *only* path in the whole flow that ever
// touches followups/injects, since both closes above stayed silent.
const historyInjectRes = await rpcHandler("historyInject", {
	sessionId: "sess-2",
	paths: [older.path, newest.path],
	notes: "对比一下这两次的输出",
});
assert.equal(historyInjectRes.ok, true);
assert.equal(historyInjectRes.value.referenced, 2);
assert.equal(injects.length, 1, "history reference is the only thing that ever queues an inject");
assert.equal(injects[0].content[0].text, "对比一下这两次的输出");
assert.equal(injects[0].source.kind, "user", "history notes render as an ordinary chat bubble");
assert.equal(followups.length, 1, "history reference is the only thing that ever wakes the model");
assert.match(followups[0].content[0].text, /历史记录/);
assert.doesNotMatch(followups[0].content[0].text, /对比一下这两次的输出/, "notes no longer embedded in the pointer message");

const historyInjectEmpty = await rpcHandler("historyInject", { sessionId: "sess-2", paths: [] });
assert.equal(historyInjectEmpty.ok, false, "empty selection rejected");
const invalidMixed = await rpcHandler("historyInject", { sessionId: "sess-2", paths: [older.path, "/not-owned.log"] });
assert.equal(invalidMixed.ok, false, "a mixed or stale selection must not silently analyze a subset");
assert.equal(followups.length, 1);
assert.equal(injects.length, 1);
const duplicates = await rpcHandler("historyInject", { sessionId: "sess-2", paths: [older.path, older.path] });
assert.equal(duplicates.value.referenced, 1, "a repeated path is referenced once");

rmSync(cwd, { recursive: true, force: true });
console.log("SMOKE-TERMINAL TEST DONE");
