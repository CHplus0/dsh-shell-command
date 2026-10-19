import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { build } from "tsdown";
import { chromium } from "playwright";
import * as nativePty from "node-pty";
import { WebSocketServer, WebSocket } from "ws";
import { createTerminalManager } from "../lib/terminal.js";
import { registerTerminalRpc, registerTerminalWs } from "../lib/rpc.js";
import { apply as applyShell } from "../lib/index.js";
import { stripAnsi } from "../lib/inject.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), "dsh-xterm-browser-"));
const input = [];
const followups = [], injections = [];
let requestActive = true;
const audit = [];
const agent = { id: "browser-session", session: { header: { cwd }, requestHeader: () => requestActive ? { cwd } : undefined,
  append(type, data) { audit.push({ type, data }); } },
  inject(message) { injections.push(message); }, followup(message) { followups.push(message); } };
const manager = createTerminalManager({
  shell: "/bin/bash", transcriptKeep: 20,
  pty: { spawn(shell, _args, options) {
    const term = nativePty.spawn(shell, ["--noprofile", "--norc", "-i"], {
      ...options, env: { ...options.env, PS1: "DSH_TEST> ", PROMPT_COMMAND: "", HISTFILE: "/dev/null", INPUTRC: "/dev/null" },
    });
    const write = term.write.bind(term);
    term.write = (data) => { input.push(data); write(data); };
    return term;
  } },
});
let rpc, bangRpc, browser, server, page, disposeWs;
const effects = [];
const ctx = { effect(fn) { const dispose = fn(); effects.push(dispose); return dispose; } };
const capturePath = process.env.DSH_BROWSER_SCREENSHOT;
const errors = [];
const waitFor = async (predicate, label, timeout = 8000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
};

try {
  writeFileSync(join(cwd, "completion-target.txt"), "COMPLETION_RESULT_5931\n");
  await build({ cwd: root, entry: { host: "test/browser-host.js" }, outDir: cwd, clean: false,
    format: "iife", platform: "browser", target: "es2022", dts: false,
    deps: { onlyBundle: [/^react(?:-dom)?(?:\/|$)/, "scheduler"], alwaysBundle: [/^react(?:-dom)?(?:\/|$)/] }, define: { "process.env.NODE_ENV": '"production"' } });
  registerTerminalRpc({ manager, agents: { get: (id) => id === agent.id ? agent : undefined },
    connection: { rpc: { handle(_channel, handler) { rpc = handler; return () => {}; } } } });
  applyShell({ effect: ctx.effect, get(name) {
    return { agents: { get: id => id === agent.id ? agent : undefined },
      connection: { rpc: { handle(_channel, handler) { bangRpc = handler; return () => {}; } } } }[name];
  } }, { terminalEnabled: false });
  server = createServer(async (req, res) => {
    try {
      if (req.url === "/rpc") {
        let body = "";
        for await (const chunk of req) body += chunk;
        const { channel, endpoint, payload } = JSON.parse(body);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(await (channel === "/shell-bang-rpc" ? bangRpc : rpc)(endpoint, payload, new AbortController().signal)));
      } else if (req.url === "/host.js" || req.url === "/client.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(readFileSync(req.url === "/host.js" ? join(cwd, "host.iife.js") : join(root, "lib/client.js")));
      } else {
        res.setHeader("content-type", "text/html");
        res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#fff;color:#0f1115;--dsw-alias-bg-layer-1:#fff;--dsw-alias-label-primary:#0f1115;--dsw-alias-label-secondary:#61666b;--dsw-alias-bg-module-platform:#f5f6f7"><div id="root"></div><script src="/host.js"></script><script src="/client.js"></script><script>mountShell()</script></body></html>');
      }
    } catch (error) { errors.push(error.message); res.statusCode = 500; res.end(String(error)); }
  });
  disposeWs = registerTerminalWs({ manager, WebSocketServer, ctx, webServer: {
    registerUpgrade({ handler }) { server.on("upgrade", handler); return () => server.off("upgrade", handler); },
  } });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  browser = await chromium.launch({ headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  });
  console.log(`BROWSER: Chromium ${browser.version()}, Node ${process.version}`);
  page = await browser.newPage({ viewport: { width: 1200, height: 850 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.fixture?.controller);
  assert.equal(await page.locator("style[data-dsh-shell-xterm]").count(), 1, "CSS ships inside the bundle");
  const open = async () => {
    await page.evaluate(() => fixture.open());
    await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "open" && fixture.controller.terminal);
    await waitFor(() => manager.get(agent.id)?.transcript.includes("DSH_TEST>"), "shell prompt");
  };
  const screen = () => page.evaluate(() => {
    const buffer = fixture.controller.terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, i) => {
      const line = buffer.getLine(i);
      return (line?.isWrapped ? "" : "\n") + (line?.translateToString(true) || "");
    }).join("");
  });
  const command = async (line, expected, waitPrompt = true) => {
    const start = manager.get(agent.id).transcript.length;
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(line);
    await page.keyboard.press("Enter");
    if (waitPrompt) await waitFor(() => {
      // Bash 5 (Linux) places bracketed-paste mode controls and an extra CR
      // between the echoed newline and the prompt, unlike macOS Bash 3.
      const tail = manager.get(agent.id)?.transcript.slice(start) ?? "";
      return stripAnsi(tail).replace(/\r/g, "").includes("\nDSH_TEST> ");
    }, `prompt after ${line}`);
    if (expected) await waitFor(async () => (await screen()).split("\n").includes(expected), `output line ${expected}`);
  };
  const checkChromeContrast = async () => {
    const values = await page.getByRole("dialog", { name: "shell terminal" }).evaluate((panel) => ({
      background: getComputedStyle(panel).backgroundColor,
      labels: Array.from(panel.querySelectorAll("button")).filter(button => ["会话", "历史", "退出", "关闭面板", "^C", "^D", "^Z", "引用并分析", "直接退出，本次不分析"].includes(button.textContent))
        .map(button => ({ name: button.textContent, color: getComputedStyle(button).color })),
    }));
    const luminance = (color) => {
      const [r, g, b] = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const bg = luminance(values.background);
    for (const label of values.labels) {
      const fg = luminance(label.color);
      assert.ok((Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05) >= 4.5, `${label.name} readable against ${values.background}`);
    }
  };

  await open();
  await checkChromeContrast();
  await page.evaluate(() => {
    document.body.style.setProperty("--dsw-alias-bg-layer-1", "#141414");
    document.body.style.setProperty("--dsw-alias-label-primary", "#eeeeee");
    document.body.style.setProperty("--dsw-alias-label-secondary", "#aaaaaa");
  });
  await checkChromeContrast();
  await page.evaluate(() => {
    for (const key of ["--dsw-alias-bg-layer-1", "--dsw-alias-label-primary", "--dsw-alias-label-secondary"]) document.body.style.removeProperty(key);
  });
  await checkChromeContrast();
  await page.evaluate(() => {
    document.body.style.setProperty("--dsw-alias-bg-layer-1", "#ffffff");
    document.body.style.setProperty("--dsw-alias-label-primary", "#0f1115");
    document.body.style.setProperty("--dsw-alias-label-secondary", "#61666b");
  });
  console.log("BROWSER: light, dark and fallback panel labels have readable contrast");
  const emptyHandle = manager.get(agent.id);
  emptyHandle.appendTranscript("\x1b[6n");
  await waitFor(() => input.some((data) => /\x1b\[\d+;\d+R/.test(data)), "xterm device-status response");
  assert.equal(emptyHandle.hasInput, false);
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  assert.equal(manager.list(cwd, agent.id).length, 0);
  console.log("BROWSER: empty close and automatic replies passed");

  // Previous releases wrote raw .log files without a metadata sidecar.
  const oldLog = manager.persist(cwd, agent.id, "\x1b]0;before\x1b\\PREVIOUS_VERSION_HISTORY\x1b]0;after\x1b\\\n");
  rmSync(oldLog.replace(/\.log$/, ".meta.json"));
  const otherLog = manager.persist(cwd, agent.id, "SECOND_HISTORY_RECORD\n", { exitCode: 3 });
  await open();
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().history.entries.length === 2);
  const oldIndex = await page.evaluate((path) => fixture.controller.state.getSnapshot().history.entries.findIndex(entry => entry.path === path), oldLog);
  await page.getByRole("button", { name: "查看", exact: true }).nth(oldIndex).click();
  await page.getByText("PREVIOUS_VERSION_HISTORY", { exact: true }).waitFor();
  await page.getByRole("button", { name: "收起", exact: true }).click();
  await page.getByRole("checkbox").nth(0).check();
  await page.getByRole("checkbox").nth(1).check();
  const notes = "请分析这两段旧终端记录";
  await page.getByPlaceholder("（可选）已选中多段记录时，可在此补充自然语言说明…").fill(notes);
  await page.getByRole("button", { name: "引用并分析 (2 段)", exact: true }).click();
  await waitFor(() => followups.length === 1 && injections.length === 1, "previous history multi-reference");
  assert.equal(injections[0].content[0].text, notes);
  assert.ok(followups[0].content[0].text.includes(oldLog) && followups[0].content[0].text.includes(otherLog));
  assert.equal(await page.getByRole("button", { name: "直接退出，本次不分析", exact: true }).count(), 0, "live PTY cannot be silently dismissed");
  await page.getByRole("button", { name: "会话", exact: true }).click();
  await page.getByRole("button", { name: "退出", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  console.log("BROWSER: legacy logs, expand/collapse preview, multi-select and notes preserved");

  await open();
  const firstStream = manager.get(agent.id).streamId;
  await page.keyboard.type("printf");
  await waitFor(() => input.includes("p"), "per-keystroke PTY input");
  await page.keyboard.type(" 'KEY_READY\\n'");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await screen()).split("\n").includes("KEY_READY"), "key output");
  await command("mkdir child; cd child; export DSH_XTERM_TEST=retained");
  await command("printf '%s|%s\\n' \"$PWD\" \"$DSH_XTERM_TEST\"", `${cwd}/child|retained`);
  await page.keyboard.type("cat ../completion-t");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await screen()).includes("COMPLETION_RESULT_5931"), "shell tab completion");
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await screen()).split("COMPLETION_RESULT_5931").length >= 3, "shell history recall");

  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "printf '%s\\n' '你好🦊'");
    document.querySelector(".xterm-helper-textarea").dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  });
  await page.keyboard.press("Enter");
  await waitFor(async () => (await screen()).includes("你好🦊"), "Unicode paste");
  await page.keyboard.type("printf '%s\\n' '");
  await page.evaluate(() => {
    const textarea = document.querySelector(".xterm-helper-textarea");
    const base = textarea.value;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    textarea.value = base + "中文输入";
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "中文输入" }));
    textarea.dispatchEvent(new InputEvent("input", { bubbles: true, data: "中文输入", inputType: "insertCompositionText", isComposing: true }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文输入" }));
  });
  await waitFor(() => input.some((data) => String(data).includes("中文输入")), "IME composition forwarding");
  await page.keyboard.type("'");
  await page.keyboard.press("Enter");
  await waitFor(async () => (await screen()).includes("中文输入"), "IME output");
  console.log("BROWSER: keystrokes, persistent shell, completion, history, CJK paste/composition passed");

  await command("sleep 30", undefined, false);
  await waitFor(() => spawnSync("pgrep", ["-P", String(manager.get(agent.id).pty.pid), "-x", "sleep"]).status === 0, "sleep child running before Ctrl+C");
  let signalStart = manager.get(agent.id).transcript.length;
  await page.keyboard.press("Control+c");
  await waitFor(() => manager.get(agent.id).transcript.slice(signalStart).includes("DSH_TEST> "), "prompt after Ctrl+C");
  await command("printf 'INTERRUPT_OK\\n'", "INTERRUPT_OK");
  await command("sleep 30", undefined, false);
  await waitFor(() => spawnSync("pgrep", ["-P", String(manager.get(agent.id).pty.pid), "-x", "sleep"]).status === 0, "sleep child running before Ctrl+Z");
  signalStart = manager.get(agent.id).transcript.length;
  await page.getByRole("button", { name: "Ctrl+Z（挂起）", exact: true }).click();
  await waitFor(() => manager.get(agent.id).transcript.slice(signalStart).includes("DSH_TEST> "), "prompt after Ctrl+Z");
  await command("kill %1; wait %1 2>/dev/null; printf 'JOB_STOP_OK\\n'", "JOB_STOP_OK");
  assert.ok(input.includes("\x03") && input.includes("\x1a"));
  await command("printf '\\rOLD_FRAME\\rNEW_FRAME\\033[K\\n'", "NEW_FRAME");
  const progress = await screen();
  assert.match(progress, /\nNEW_FRAME\n/, "CR overwrites the displayed line");
  await command("printf '\\033[?1049hALT_SCREEN\\n'");
  await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "alternate");
  await page.evaluate(() => { fixture.originalTerminal = fixture.controller.terminal; });
  await page.getByRole("button", { name: "历史", exact: true }).click();
  await page.getByRole("button", { name: "会话", exact: true }).click();
  assert.equal(await page.evaluate(() => fixture.originalTerminal === fixture.controller.terminal), true);
  assert.equal((await screen()).split("ALT_SCREEN").length, 2, "tab switch never replays output");
  await command("printf '\\033[?1049l\\n'");
  await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "normal");

  await page.evaluate(() => fixture.controller.setGeometry({ width: 850, height: 560 }));
  await waitFor(async () => {
    const size = await page.evaluate(() => ({ cols: fixture.controller.terminal.cols, rows: fixture.controller.terminal.rows }));
    return size.cols > 80 && size.rows > 20;
  }, "container refit");
  const size = await page.evaluate(() => ({ cols: fixture.controller.terminal.cols, rows: fixture.controller.terminal.rows }));
  await command("stty size");
  await waitFor(() => manager.get(agent.id).transcript.includes(`${size.rows} ${size.cols}`), "real PTY dimensions");
  console.log("BROWSER: Ctrl+C/Z, progress overwrite, alternate screen, tab preservation and resize passed");

  if (spawnSync("vim", ["--version"], { encoding: "utf8" }).status === 0) {
    await command("vim -Nu NONE -n fixture.txt", undefined, false);
    await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "alternate");
    await page.keyboard.type("iVIM_EDIT_CONFIRMED");
    await page.keyboard.press("Escape");
    await page.keyboard.type(":wq");
    await page.keyboard.press("Enter");
    await waitFor(() => existsSync(join(cwd, "child/fixture.txt")) && readFileSync(join(cwd, "child/fixture.txt"), "utf8").includes("VIM_EDIT_CONFIRMED"), "vim saved edit");
    await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "normal");
    console.log("BROWSER: real vim edit/save/exit passed");
  } else console.log("BROWSER: vim unavailable; alternate screen verified independently");
  if (spawnSync("htop", ["--version"], { encoding: "utf8" }).status === 0) {
    await command("htop", undefined, false);
    await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "alternate");
    await page.keyboard.press("q");
    await page.waitForFunction(() => fixture.controller.terminal.buffer.active.type === "normal");
    console.log("BROWSER: htop passed");
  } else console.log("BROWSER: htop unavailable (optional)");

  if (capturePath) await page.screenshot({ path: capturePath });
  await page.keyboard.press("Control+d");
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "ended");
  assert.ok(input.includes("\x04"));
  assert.equal(manager.get(agent.id), undefined, "natural exit releases the PTY registry");
  assert.equal(manager.list(cwd, agent.id).length, 3);
  assert.equal(followups.length, 1, "close itself never wakes the model");
  assert.equal(injections.length, 1);
  assert.equal(await page.getByRole("checkbox").first().isChecked(), true);
  await page.getByRole("button", { name: "收起", exact: true }).waitFor();
  await checkChromeContrast();
  if (capturePath) await page.screenshot({ path: capturePath.replace(/\.png$/, "-history.png") });
  await page.getByRole("button", { name: "引用并分析", exact: true }).click();
  await waitFor(() => followups.length === 2 && injections.length === 2, "history reference");
  await page.getByRole("button", { name: "直接退出，本次不分析", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  assert.equal(followups.length, 2, "dismiss never wakes the model");

  await open();
  assert.notEqual(manager.get(agent.id).streamId, firstStream);
  assert.doesNotMatch(await screen(), /VIM_EDIT_CONFIRMED|COMPLETION_RESULT_5931/, "reopen has clean buffers");
  await command("printf 'DISCONNECT_TEST\\n'", "DISCONNECT_TEST");
  for (const ws of manager.get(agent.id).watchers) ws.terminate();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "error");
  const writesBefore = input.length;
  await page.evaluate(() => fixture.controller.sendRaw("must-not-arrive"));
  assert.equal(input.length, writesBefore, "disconnect disables input");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  assert.equal(manager.get(agent.id), undefined, "closing a disconnected panel cleans the PTY");

  await open();
  await command("printf 'OFFLINE_EXIT_RECORD\\n'", "OFFLINE_EXIT_RECORD");
  const offline = manager.get(agent.id);
  const historyBeforeOfflineExit = manager.list(cwd, agent.id).length;
  for (const ws of offline.watchers) ws.terminate();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "error");
  offline.pty.write("exit 9\r");
  await waitFor(() => offline.exited && manager.list(cwd, agent.id).length === historyBeforeOfflineExit + 1, "offline natural exit persists on host");
  const offlinePath = manager.list(cwd, agent.id)[0].path;
  assert.match(manager.readTranscript(offlinePath), /OFFLINE_EXIT_RECORD/);
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  assert.equal(manager.list(cwd, agent.id).length, historyBeforeOfflineExit + 1, "late close never duplicates the offline record");
  assert.equal(manager.list(cwd, agent.id)[0].exitCode, 9);
  console.log("BROWSER: disconnected natural exit persists exactly once with the final exit code");
  await open();
  await rpc("close", { sessionId: agent.id, streamId: manager.get(agent.id).streamId });
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "error");
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  await page.waitForFunction(() => fixture.controller.state.getSnapshot().status === "closed");
  await open();
  await page.evaluate(() => fixture.dispose());
  await waitFor(() => manager.get(agent.id) === undefined, "scope disposal closes server PTY");
  assert.equal(await page.locator("style[data-dsh-shell-xterm]").count(), 0);
  assert.equal(await page.locator(".xterm").count(), 0);
  assert.equal(await page.evaluate(() => fixture.controller.outputListeners.size), 0);
  // A session scope can disappear while the open RPC is still in flight.
  await page.reload();
  await page.waitForFunction(() => window.fixture?.controller);
  let releaseOpen;
  const gate = new Promise((resolve) => { releaseOpen = resolve; });
  let heldOpen = false;
  await page.route("**/rpc", async (route) => {
    if (route.request().postDataJSON().endpoint !== "open") return route.continue();
    const response = await route.fetch();
    heldOpen = true;
    await gate;
    await route.fulfill({ response });
  });
  await page.evaluate(() => { fixture.open(); fixture.open(); });
  await waitFor(() => heldOpen && manager.get(agent.id), "pending open created PTY");
  await page.evaluate(() => fixture.dispose());
  releaseOpen();
  await waitFor(() => manager.get(agent.id) === undefined, "disposed pending open cleans its late result");
  await page.unroute("**/rpc");

  // Use the actual shipped controller with explicitly reordered transport replies.
  await page.reload();
  await page.waitForFunction(() => window.fixture?.controller);
  const races = await page.evaluate(async () => {
    const controller = fixture.controller;
    const original = controller.connection;
    const pending = [];
    controller.connection = { rpc: { call(_channel, endpoint, payload) {
      return new Promise((resolve, reject) => pending.push({ endpoint, payload, resolve, reject }));
    } } };
    const success = transcript => ({ ok: true, value: { transcript } });
    const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
    try {
      controller.togglePreview("A"); controller.togglePreview("B");
      pending[1].resolve(success("B content")); await flush();
      pending[0].resolve(success("A content")); await flush();
      const newest = controller.state.getSnapshot().preview.path;
      controller.togglePreview("collapse"); controller.togglePreview("collapse");
      pending[2].resolve(success("must remain hidden")); await flush();
      const collapsed = controller.state.getSnapshot().preview;
      controller.togglePreview("old-error"); controller.togglePreview("latest");
      pending[4].resolve(success("latest")); pending[3].reject(new Error("old failure")); await flush();
      const lateError = controller.state.getSnapshot().preview.path;
      controller.togglePreview("before-tab-switch"); controller.setTab("live");
      pending[5].resolve(success("must not reopen preview")); await flush();
      const switched = controller.state.getSnapshot().preview;
      controller.loadHistory(); controller.loadHistory();
      pending[7].resolve({ ok: true, value: { entries: [{ path: "new" }] } }); await flush();
      pending[6].resolve({ ok: true, value: { entries: [{ path: "old" }] } }); await flush();
      const history = controller.state.getSnapshot().history.entries[0].path;
      return { newest, collapsed, lateError, switched, history };
    } finally { controller.connection = original; }
  });
  assert.deepEqual(races, { newest: "B", collapsed: null, lateError: "latest", switched: null, history: "new" });
  console.log("BROWSER: out-of-order preview/history replies, collapse, tab switch and stale errors passed");

  await open();
  const live = manager.get(agent.id);
  const malformed = new WebSocket(`ws://127.0.0.1:${server.address().port}/shell-term/ws?sessionId=${agent.id}&streamId=${live.streamId}&protocol=2`);
  malformed.on("error", () => {});
  await new Promise((resolve, reject) => { malformed.once("open", resolve); malformed.once("error", reject); });
  const malformedClosed = new Promise(resolve => malformed.once("close", resolve));
  // Unmasked client text frame: valid HTTP upgrade, invalid RFC 6455 framing.
  malformed._socket.write(Buffer.from([0x81, 0x01, 0x61]));
  await malformedClosed;
  assert.equal(manager.get(agent.id), live, "one malformed socket cannot take down the host or the PTY");
  assert.equal(live.hasInput, false);
  await page.evaluate(() => fixture.controller.dismiss());
  assert.equal(manager.get(agent.id), undefined);
  console.log("BROWSER: malformed WebSocket wire frame is isolated without a host crash");

  const bang = await page.evaluate(async () => {
    const source = fixture.sources.get("shell-bang");
    const session = { sessionId: "browser-session" };
    const claim = await source.matchEnter(session, "/! printf 'BANG_BROWSER_OK'");
    return claim.claim.submit();
  });
  assert.equal(bang.kind, "success");
  assert.match(followups.at(-1).content[0].text, /BANG_BROWSER_OK/);
  assert.deepEqual(audit.slice(-2).map(event => event.type), ["command/run", "command/done"]);
  const auditCount = audit.length;
  const followupCount = followups.length;
  requestActive = false;
  const beforeFirstRequest = await page.evaluate(async () => {
    const claim = await fixture.sources.get("shell-bang").matchEnter({ sessionId: "browser-session" }, "/! printf never-execute");
    return claim.claim.submit();
  });
  assert.equal(beforeFirstRequest.kind, "error");
  assert.match(beforeFirstRequest.text, /No model request exists yet/);
  assert.equal(audit.length, auditCount);
  assert.equal(followups.length, followupCount);
  console.log("BROWSER: /! trigger executes, audits, analyzes and rejects a conversation without a model request");
  assert.deepEqual(errors, []);
  console.log("BROWSER TESTS PASSED: natural Ctrl+D exit, history reference, clean reopen, disconnect, disposal and pending-open race");
} catch (error) {
  console.error("Browser errors:", errors);
  console.error("PTY tail:", manager.get(agent.id)?.transcript.slice(-4000));
  if (page) console.error("Browser state:", await page.evaluate(() => fixture.controller.state.getSnapshot()).catch(() => null));
  throw error;
} finally {
  await browser?.close();
  manager.disposeAll();
  disposeWs?.();
  for (const dispose of effects.reverse()) dispose?.();
  server?.closeAllConnections();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  rmSync(cwd, { recursive: true, force: true });
}
