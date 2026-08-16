// Standalone smoke test for dsh-shell-command: exercises the real apply()
// against a mock Cordis context, running real commands through the
// child_process fallback (the mock returns undefined for "subprocess").
//
// Requires the @deepseek-ai/* peer packages to resolve from this checkout.
// Inside a DSH profile they already do; outside one, link them once:
//   mkdir -p node_modules/@deepseek-ai
//   ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai/"* node_modules/@deepseek-ai/
//
//   node test/smoke.mjs
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { apply } from "../lib/index.js";

const dir = mkdtempSync(join(tmpdir(), "shell-cmd-smoke-"));

let registered;
const ctx = {
	get(name) {
		// Force the child_process fallback; a real profile provides ctx.subprocess.
		return undefined;
	},
	effect(fn) {
		fn(); // run the register body immediately; ignore the disposer
		return () => {};
	},
	commands: {
		register(definition) {
			registered = definition;
			return () => {};
		},
	},
	logger: { warn: (...a) => console.log("[warn]", ...a) },
};

apply(ctx, { timeoutMs: 1500, maxOutputBytes: 1024 });

assert.ok(registered, "command registered");
assert.equal(registered.name, "shell");
assert.equal(typeof registered.handler, "function");

const followups = [];
const agent = {
	id: "smoke-1",
	session: { header: { cwd: dir } },
	followup(message) {
		followups.push(message);
	},
};
const signal = new AbortController().signal;
const invoke = (rawInput, commandId) => registered.handler({ commandId, agent, rawInput, signal });

// Mode 1: display only
const r1 = await invoke("printf hello");
assert.equal(r1.kind, "success");
assert.match(r1.text, /hello/);
assert.match(r1.text, /exit code 0/);
assert.equal(followups.length, 0, "display mode must not wake the model");

// Mode 2: analyze (long flag)
const r2 = await invoke("--analyze printf world");
assert.equal(r2.kind, "success");
assert.match(r2.text, /world/);
assert.equal(followups.length, 1, "analyze mode follows up exactly once");
assert.equal(followups[0].role, "user");
assert.equal(followups[0].source.kind, "plugin");
assert.equal(followups[0].source.plugin, "shell-command");
assert.match(followups[0].content[0].text, /world/);

// Mode 2: short flag
await invoke("-a printf again");
assert.equal(followups.length, 2, "short -a also follows up");

// non-zero exit code
const r4 = await invoke("sh -c 'exit 3'");
assert.equal(r4.kind, "success");
assert.match(r4.text, /exit code 3/);

// empty input
const r5 = await invoke("");
assert.equal(r5.kind, "error");

// command that does not exist
const r6 = await invoke("definitely-not-a-real-command-xyz");
assert.equal(r6.kind, "success");
assert.match(r6.text, /exit code 127/);

// timeout (sleep 5 > 1500ms)
const started = Date.now();
const r7 = await invoke("sleep 5");
assert.equal(r7.kind, "success");
assert.match(r7.text, /timed out after 1500ms/);
assert.ok(Date.now() - started < 5000, "timeout fired promptly");

rmSync(dir, { recursive: true, force: true });
console.log("SMOKE TEST DONE");
