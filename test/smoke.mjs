// Standalone smoke test for dsh-shell-command: exercises the real apply()
// against a mock Cordis context with RPC handlers, running real commands
// through the child_process fallback (the mock returns undefined for "subprocess").
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

let rpcHandler;
const followups = [];
const audit = [];
const agent = {
	id: "smoke-1",
	session: {
		header: { cwd: dir },
		append(type, data) { audit.push({ type, data }); },
		requestHeader() {
			return { cwd: dir };
		},
	},
	followup(message) {
		followups.push(message);
	},
};

const ctx = {
	get(name) {
		if (name === "connection") {
			return {
				rpc: {
					handle(channel, handler, opts) {
						if (channel === "/shell-bang-rpc") {
							rpcHandler = handler;
						}
						return () => {};
					},
				},
			};
		}
		if (name === "agents") {
			return {
				get(sessionId) {
					return sessionId === "smoke-1" ? agent : undefined;
				},
			};
		}
		return undefined;
	},
	effect(fn) {
		fn();
		return () => {};
	},
	logger: { warn: (...a) => console.log("[warn]", ...a) },
};

apply(ctx, { timeoutMs: 1500, maxOutputBytes: 1024, terminalEnabled: false });

assert.ok(rpcHandler, "RPC handler registered");

const signal = new AbortController().signal;
const invoke = (command) => rpcHandler("run", { sessionId: "smoke-1", command }, signal);

// Basic execution
const r1 = await invoke("printf hello");
assert.equal(r1.ok, true);
assert.equal(followups.length, 1, "bang trigger always follows up");
assert.equal(followups[0].role, "user");
assert.equal(followups[0].source.kind, "plugin");
assert.equal(followups[0].source.plugin, "shell-command");
assert.match(followups[0].content[0].text, /hello/);
assert.match(followups[0].content[0].text, /exit code 0/);
assert.deepEqual(audit.map(event => event.type), ["command/run", "command/done"]);
assert.equal(audit[0].data.args, "printf hello");
assert.equal(audit[0].data.commandId, audit[1].data.commandId);

// Another command
await invoke("printf world");
assert.equal(followups.length, 2, "second command also follows up");
assert.match(followups[1].content[0].text, /world/);

// non-zero exit code
const r4 = await invoke("sh -c 'exit 3'");
assert.equal(r4.ok, true);
assert.match(followups[2].content[0].text, /exit code 3/);

// empty input
const r5 = await invoke("");
assert.equal(r5.ok, false);
assert.match(r5.error.message, /Usage/);

// command that does not exist
const r6 = await invoke("definitely-not-a-real-command-xyz");
assert.equal(r6.ok, true);
assert.match(followups[3].content[0].text, /exit code 127/);

// timeout (sleep 5 > 1500ms)
const started = Date.now();
const r7 = await invoke("sleep 5");
assert.equal(r7.ok, true);
assert.match(followups[4].content[0].text, /timed out after 1500ms/);
assert.ok(Date.now() - started < 5000, "timeout fired promptly");
await invoke("pwd");
assert.ok(followups.at(-1).content[0].text.includes(dir), "command runs in the receiving session workspace");

// session without followup (to test that RPC properly checks for it)
const agentNoFollowup = {
	id: "no-followup",
	session: {},
	followup(message) {
		// Mock followup that does nothing
	},
};
const ctxNoFollowup = {
	...ctx,
	get(name) {
		if (name === "connection") return ctx.get("connection");
		if (name === "agents") {
			return { get(sid) { return sid === "no-followup" ? agentNoFollowup : undefined; } };
		}
		return undefined;
	},
};
let rpcHandlerNoFollowup;
const ctxNoFollowupApplied = {
	...ctxNoFollowup,
	get(name) {
		if (name === "connection") {
			return {
				rpc: {
					handle(channel, handler) {
						if (channel === "/shell-bang-rpc") rpcHandlerNoFollowup = handler;
						return () => {};
					},
				},
			};
		}
		if (name === "agents") return ctxNoFollowup.get("agents");
		return undefined;
	},
	effect: ctx.effect,
	logger: ctx.logger,
};
apply(ctxNoFollowupApplied, { terminalEnabled: false });

// A new conversation must be rejected before any shell side effect.
const r8 = await rpcHandlerNoFollowup("run", { sessionId: "no-followup", command: "echo test" }, signal);
assert.equal(r8.ok, false);
assert.match(r8.error.message, /No model request exists yet/);

rmSync(dir, { recursive: true, force: true });
console.log("SMOKE TEST DONE");

