import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalManager } from "../lib/terminal.js";
import { registerTerminalRpc, registerTerminalWs, setupTerminalMode } from "../lib/rpc.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-term-protocol-"));
const instances = [];
let failSpawn = false;
const pty = { spawn() {
  if (failSpawn) throw new Error("spawn failed");
  const process = { inputs: [], sizes: [], kills: 0,
    onData(cb) { this.emit = cb; }, onExit(cb) { this.end = cb; },
    write(data) { this.inputs.push(data); }, resize(...size) { this.sizes.push(size); },
    kill() { this.kills++; this.end?.({ exitCode: 0 }); },
  };
  instances.push(process);
  return process;
} };
const manager = createTerminalManager({ pty, maxTranscriptBytes: 1024 });
const agent = { id: "owner", session: { header: { cwd } },
  inject() { throw new Error("close must not inject"); }, followup() { throw new Error("close must not wake"); } };
let rpc;
const agents = { get: (id) => id === agent.id ? agent : undefined };
registerTerminalRpc({ manager, agents, connection: { rpc: { handle(_channel, handler) { rpc = handler; return () => {}; } } } });
const call = (endpoint, payload = {}) => rpc(endpoint, { sessionId: "owner", ...payload });
function socket() {
  const ws = new EventEmitter();
  ws.readyState = 1;
  ws.sent = [];
  ws.send = (data) => ws.sent.push(data);
  ws.close = () => { ws.readyState = 3; ws.emit("close"); };
  ws.input = (frame) => ws.emit("message", Buffer.from(JSON.stringify(frame)));
  return ws;
}

try {
  failSpawn = true;
  assert.equal((await call("open")).ok, false);
  failSpawn = false;
  const opened = await call("open");
  assert.equal(opened.ok, true, "failed spawn clears its opening guard");
  const streamId = opened.value.streamId;
  assert.equal((await call("open")).value.streamId, streamId, "repeated open reuses the PTY");
  assert.equal(instances.length, 1);
  const handle = manager.get("owner");
  handle.pty.emit("prompt\x1b[6n");
  const ws = socket();
  manager.attachWs("owner", ws, { structured: true, streamId });
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: "output", data: "prompt\x1b[6n" });
  ws.input({ type: "input", data: "\x1b[1;1R" });
  assert.equal(handle.hasInput, false, "device-status replies are not user input");
  assert.equal(handle.pty.inputs[0], "\x1b[1;1R");
  ws.emit("message", Buffer.from("bad json"));
  ws.input({ type: "unknown" });
  ws.input({ type: "input", data: 4 });
  assert.equal(handle.pty.inputs.length, 1);
  const broken = socket();
  manager.attachWs("owner", broken, { structured: true, streamId });
  assert.doesNotThrow(() => broken.emit("error", new Error("invalid WebSocket frame")));
  assert.equal(handle.watchers.has(broken), false, "failed transport is detached without crashing the host");
  assert.equal((await call("close", { streamId })).value.transcriptPath, null);
  assert.equal(manager.list(cwd, "owner").length, 0, "automatic responses leave no history");

  const next = (await call("open")).value.streamId;
  assert.notEqual(next, streamId);
  const restarted = createTerminalManager({ pty });
  const restartedHandle = restarted.open("owner", { cwd });
  assert.notEqual(restartedHandle.streamId, streamId, "host reload cannot reuse an old generation id");
  const beforeReload = socket();
  restarted.attachWs("owner", beforeReload, { streamId });
  assert.equal(beforeReload.readyState, 3, "old streams cannot attach after host reload");
  restarted.disposeAll();
  const stale = socket();
  manager.attachWs("owner", stale, { streamId });
  assert.equal(stale.readyState, 3, "late attach cannot reach a new PTY");
  assert.equal((await call("close", { streamId })).ok, false, "late close cannot kill a new PTY");
  const nextHandle = manager.get("owner");
  const nextWs = socket();
  manager.attachWs("owner", nextWs, { structured: true, streamId: next });
  assert.equal((await call("resize", { cols: 120, rows: 35, streamId: next })).ok, true);
  assert.deepEqual(nextHandle.pty.sizes, [[120, 35]]);
  for (const value of [0, -1, 1, 2.5, "80", null, Infinity, NaN, 1001]) {
    assert.equal((await call("resize", { cols: value, rows: 24 })).ok, false, `reject dimension ${value}`);
  }
  assert.equal((await rpc("resize", { sessionId: "missing", cols: 80, rows: 24 })).error.code, "session-not-found");
  assert.equal(nextHandle.pty.sizes.length, 1, "invalid requests never resize");
  nextWs.input({ type: "activity" });
  nextWs.input({ type: "input", data: "你\t\x03" });
  nextWs.input({ type: "binary", data: [255, 0, 27] });
  nextWs.input({ type: "binary", data: [256] });
  assert.equal(nextHandle.hasInput, true);
  assert.equal(nextHandle.pty.inputs[0], "你\t\x03", "input is passed through without appended newlines");
  assert.deepEqual(nextHandle.pty.inputs[1], Buffer.from([255, 0, 27]));
  assert.equal(nextHandle.pty.inputs.length, 2);
  nextHandle.pty.emit("vim\x1b[?1049h\rprogress");
  nextHandle.pty.end({ exitCode: 7 });
  assert.deepEqual(JSON.parse(nextWs.sent.at(-1)), { type: "exit", exitCode: 7 });
  assert.equal((await call("resize", { cols: 80, rows: 24 })).ok, false);
  nextWs.input({ type: "input", data: "ignored" });
  assert.equal(nextHandle.pty.inputs.length, 2, "exited PTYs cannot receive input");
  const late = socket();
  manager.attachWs("owner", late, { structured: true });
  assert.equal(JSON.parse(late.sent.at(-1)).exitCode, 7, "exit before attach is reported");
  const closed = await call("close", { streamId: next });
  assert.equal(closed.value.exitCode, 7);
  assert.equal(manager.list(cwd, "owner").length, 1);
  assert.equal(nextHandle.watchers.size, 0);
  assert.equal(nextHandle.structuredWatchers.size, 0);
  assert.match(manager.readTranscript(closed.value.transcriptPath), /\x1b\[\?1049h/);

  const legacy = manager.open("legacy", { cwd });
  const legacyWs = socket();
  manager.attachWs("legacy", legacyWs);
  legacyWs.emit("message", Buffer.from("pwd\n"));
  assert.equal(legacy.hasInput, true, "raw clients retain their original input tracking");
  legacy.pty.emit("raw output");
  assert.equal(legacyWs.sent.at(-1), "raw output");
  legacyWs.close();
  assert.equal(legacy.watchers.size, 0);
  failSpawn = true;
  assert.throws(() => manager.open("legacy", { cwd: join(cwd, "changed") }), /spawn failed/);
  assert.equal(manager.get("legacy"), undefined, "failed replacement never returns the killed previous PTY");
  failSpawn = false;
  manager.open("legacy", { cwd });
  manager.disposeAll();
  assert.equal(manager.get("legacy"), undefined);

  // Exercise production URL parsing, not just direct manager attachment.
  let upgrade, attach;
  class Server { handleUpgrade(_req, _socket, _head, cb) { cb({}); } close() {} }
  const dispose = registerTerminalWs({
    manager: { attachWs(...args) { attach = args; } }, WebSocketServer: Server,
    webServer: { registerUpgrade(value) { upgrade = value.handler; return () => {}; } },
    ctx: { effect(fn) { fn(); } },
  });
  upgrade({ url: "/shell-term/ws?sessionId=owner&streamId=stream&protocol=2" }, {}, Buffer.alloc(0));
  assert.deepEqual(attach, ["owner", {}, { structured: true, streamId: "stream" }]);
  dispose();
  const warnings = [];
  const noop = await setupTerminalMode({ get() {}, logger: { warn(text) { warnings.push(text); } } }, {});
  noop();
  assert.match(warnings[0], /disabled/);
  console.log("TERMINAL PROTOCOL TESTS PASSED");
} finally {
  manager.disposeAll();
  rmSync(cwd, { recursive: true, force: true });
}
