// Requirements-driven regressions: real OS commands, Cordis dependency gating,
// UTF-8 retention, and persistence without a connected browser.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as plugin from "../lib/index.js";
import { runCommand } from "../lib/exec.js";
import { tailTranscript } from "../lib/inject.js";
import { createAnalysisMessage } from "../lib/message.js";
import { createTerminalManager } from "../lib/terminal.js";
import { registerTerminalRpc } from "../lib/rpc.js";

const cwd = mkdtempSync(join(tmpdir(), "dsh-review-regressions-"));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  // Compare retained text with an independent code-point suffix oracle.
  for (const text of ["123456789", "aaaa😀xxxx", "中", "你😀好é\r\n尾巴", "😀".repeat(20)]) {
    for (let cap = 1; cap <= Buffer.byteLength(text) + 1; cap++) {
      let expected = "";
      for (const character of Array.from(text).reverse()) {
        if (Buffer.byteLength(character + expected) > cap) break;
        expected = character + expected;
      }
      const actual = tailTranscript(text, cap);
      assert.equal(actual.text, expected);
      assert.ok(actual.text.isWellFormed());
      assert.ok(Buffer.byteLength(actual.text) <= cap);
    }
  }
  const literal = createAnalysisMessage({ command: "echo '$& {output}'", cwd: "/tmp/{command}",
    outputText: "$` $' {cwd}", template: "{command}|{cwd}|{output}", summary: "test" });
  assert.equal(literal.content[0].text, "echo '$& {output}'|/tmp/{command}|$` $' {cwd}");

  // Real Cordis must load /! without the optional web service.
  const ctx = new Context();
  const handlers = new Map();
  ctx.provide("connection", { rpc: { handle(channel, handler) { handlers.set(channel, handler); return () => handlers.delete(channel); } } });
  ctx.provide("agents", { get() {} });
  const fiber = ctx.plugin(plugin, { terminalEnabled: false });
  await fiber;
  assert.equal(typeof handlers.get("/shell-bang-rpc"), "function");
  await fiber.dispose();
  assert.equal(handlers.size, 0);
  const optional = ctx.plugin(plugin, { terminalEnabled: true });
  await optional;
  assert.equal(typeof handlers.get("/shell-bang-rpc"), "function");
  assert.equal(handlers.has("/shell-term-rpc"), false);
  ctx.provide("webServer", { registerUpgrade() { return () => {}; } });
  for (let attempt = 0; attempt < 100 && !handlers.has("/shell-term-rpc"); attempt++) await delay(10);
  assert.equal(typeof handlers.get("/shell-term-rpc"), "function", "late optional service enables terminal mode");
  await optional.dispose();
  assert.equal(handlers.size, 0);

  // Verify the preferred subprocess seam's real contract, including failure.
  let spawnSpec;
  const subprocess = { spawn(spec) {
    spawnSpec = spec;
    return { done: Promise.resolve({ exitCode: 2, signal: null }), collected: {
      stdout: { readFrom(offset) { assert.equal(offset, 0); return { text: "retained tail", lossy: true }; } },
      stderr: { readFrom() { return { text: "diagnostic", lossy: false }; } },
    } };
  } };
  const managedInput = { command: "test command", shell: "/configured/shell", shellArgs: ["-c"],
    cwd, timeoutMs: 5000, graceMs: 100, maxOutputBytes: 16, subprocess };
  const managed = await runCommand(managedInput);
  assert.deepEqual(spawnSpec.argv, ["/configured/shell", "-c", "test command"]);
  assert.equal(spawnSpec.cwd, cwd);
  assert.equal(spawnSpec.stdio.stdout.maxBytes, 16);
  assert.equal(spawnSpec.graceMs, 100);
  assert.equal(managed.exitCode, 2);
  assert.deepEqual(managed.stdout, { text: "retained tail", truncated: true });
  assert.deepEqual(managed.stderr, { text: "diagnostic", truncated: false });
  const failedManaged = await runCommand({ ...managedInput, subprocess: {
    spawn() { return { done: Promise.reject(new Error("spawn rejected")) }; },
  } });
  assert.equal(failedManaged.ok, false);
  assert.match(failedManaged.error.message, /spawn rejected/);

  if (process.platform !== "win32") {
    const base = { shell: "/bin/bash", shellArgs: ["-c"], cwd, timeoutMs: 150,
      graceMs: 80, maxOutputBytes: 1024 };
    const started = Date.now();
    const timeout = await runCommand({ ...base, command: "trap '' TERM; sleep 2; printf should-not-run" });
    assert.equal(timeout.timedOut, true);
    assert.ok(Date.now() - started < 1500, "ignoring TERM cannot bypass the deadline");
    assert.doesNotMatch(timeout.stdout.text, /should-not-run/);

    const cancelled = new AbortController();
    cancelled.abort();
    const marker = join(cwd, "pre-cancelled");
    const result = await runCommand({ ...base, command: `printf bad > ${quote(marker)}`, signal: cancelled.signal });
    assert.equal(result.cancelled, true);
    assert.equal(existsSync(marker), false, "pre-cancelled requests must never spawn");

    const descendantMarker = join(cwd, "surviving-descendant");
    await runCommand({ ...base,
      command: `trap 'exit 0' TERM; (trap '' TERM; sleep 1; printf bad > ${quote(descendantMarker)}) </dev/null >/dev/null 2>&1 & wait` });
    await delay(1100);
    assert.equal(existsSync(descendantMarker), false, "escalation must survive root exit and closed pipes");

    const text = await runCommand({ ...base, command: "printf 'aaaa😀xxxx'", timeoutMs: 1000, maxOutputBytes: 7 });
    assert.equal(text.stdout.text, "xxxx", "bounded command output cannot start in the middle of UTF-8");
    const missing = await runCommand({ ...base, command: "echo never", shell: join(cwd, "missing-shell") });
    assert.equal(missing.ok, false);
    const runningCancel = new AbortController();
    const pending = runCommand({ ...base, command: "trap '' TERM; sleep 2", timeoutMs: 5000, signal: runningCancel.signal });
    setTimeout(() => runningCancel.abort(), 100);
    const stopped = await pending;
    assert.equal(stopped.cancelled, true);
    assert.equal(stopped.timedOut, false);
    const prior = process.env.DSH_REVIEW_HIDDEN;
    process.env.DSH_REVIEW_HIDDEN = "private-test-value";
    try {
      const env = await runCommand({ ...base, command: 'printf "%s" "${DSH_REVIEW_HIDDEN-unset}"', timeoutMs: 1000 });
      assert.equal(env.stdout.text, "unset", "DSH environment facts must not leak to the command");
    } finally {
      if (prior === undefined) delete process.env.DSH_REVIEW_HIDDEN;
      else process.env.DSH_REVIEW_HIDDEN = prior;
    }
  }

  const pty = { spawn() { return {
    onData(cb) { this.output = cb; }, onExit(cb) { this.end = cb; }, write() {}, resize() {},
    kill(signal) { this.kills = (this.kills ?? 0) + 1; this.output("final shutdown output\n"); this.end({ exitCode: signal === "SIGKILL" ? 137 : 0 }); },
  }; } };
  const manager = createTerminalManager({ pty, graceMs: 20 });
  try {
    let rpc;
    const agent = { id: "owner", session: { header: { cwd } },
      inject() { throw new Error("closing must not inject"); }, followup() { throw new Error("closing must not wake"); } };
    registerTerminalRpc({ manager, agents: { get: id => id === agent.id ? agent : undefined },
      connection: { rpc: { handle(_channel, handler) { rpc = handler; return () => {}; } } } });
    const call = (endpoint, extra = {}) => rpc(endpoint, { sessionId: agent.id, ...extra });
    await call("open");
    const offline = manager.get(agent.id);
    manager.write(agent.id, "echo results\r");
    offline.pty.output("important offline results\n");
    offline.pty.end({ exitCode: 7 });
    assert.equal(manager.list(cwd, agent.id).length, 1, "natural exit persists without any socket");
    const oldPath = manager.list(cwd, agent.id)[0].path;
    const close = await call("close", { streamId: offline.streamId });
    assert.equal(close.value.transcriptPath, oldPath, "close reuses the already-persisted file");
    assert.equal(manager.list(cwd, agent.id).length, 1, "natural exit and close never duplicate history");
    assert.equal(close.value.exitCode, 7);
    await call("open");
    assert.equal(manager.list(cwd, agent.id).length, 1);
    assert.equal(manager.get(agent.id).transcript, "");
    await call("close");

    const empty = manager.open("empty", { cwd });
    empty.pty.output("prompt"); empty.pty.end({ exitCode: 0 });
    assert.equal(manager.list(cwd, "empty").length, 0);
    await manager.finish("empty");

    // Late PTY output and the final exit status must be captured on close.
    const draining = manager.open("drain", { cwd });
    manager.write("drain", "input");
    draining.pty.kill = function () { setTimeout(() => { this.output("late final output"); this.end({ exitCode: 3 }); }, 5); };
    const drained = await manager.finish("drain");
    assert.equal(drained.exitCode, 3);
    assert.match(manager.readTranscript(drained.transcriptPath), /late final output/);

    const stubborn = manager.open("stubborn", { cwd });
    stubborn.pty.kill = function(signal) { if (signal === "SIGKILL") this.end({ exitCode: 137 }); };
    assert.equal((await manager.finish("stubborn")).exitCode, 137);

    // Failed persistence is an error, with the transcript still available for retry.
    const retryCwd = join(cwd, "retry"); mkdirSync(retryCwd);
    const blocker = join(retryCwd, ".dsh-shell-transcripts"); writeFileSync(blocker, "blocked");
    manager.open("retry", { cwd: retryCwd }); manager.write("retry", "input");
    await assert.rejects(manager.finish("retry"));
    assert.ok(manager.get("retry"));
    rmSync(blocker);
    const retried = await manager.finish("retry");
    assert.ok(existsSync(retried.transcriptPath));
    assert.equal(manager.get("retry"), undefined);

    // Prefix-related owner ids must neither read nor prune one another's files.
    const owned = manager.persist(cwd, "prefix-other", "private record");
    assert.equal(manager.list(cwd, "prefix").length, 0);
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : ["2026-10-19T01:02:03.004Z"])); }
    };
    try { for (let i = 0; i < 12; i++) manager.persist(cwd, "prefix", `own ${i}`); }
    finally { globalThis.Date = RealDate; }
    assert.ok(existsSync(owned));
    assert.equal(manager.list(cwd, "prefix").length, 10);
    assert.deepEqual(manager.list(cwd, "prefix").map(entry => manager.readTranscript(entry.path)),
      Array.from({ length: 10 }, (_, index) => `own ${11 - index}`), "same-millisecond collisions keep the newest records in order");
    assert.equal(manager.list(cwd, "prefix-other").length, 1);
    const legacyPath = manager.persist(cwd, "legacy", "legacy record");
    const { renameSync } = await import("node:fs");
    const legacyName = legacyPath.replace(/-\d+\.log$/, ".log");
    renameSync(legacyPath, legacyName);
    assert.equal(manager.list(cwd, "legacy")[0].path, legacyName, "legacy filenames without counters still work");
  } finally { manager.disposeAll(); }
  console.log("REQUIREMENTS REGRESSIONS PASSED");
} finally { rmSync(cwd, { recursive: true, force: true }); }
