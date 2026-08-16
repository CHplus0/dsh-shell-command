// Dependency-free unit tests for the pure parsing and formatting helpers.
//   node test/unit.mjs
import assert from "node:assert/strict";
import { parseLine } from "../lib/parse.js";
import { formatResult, formatSummary } from "../lib/format.js";

// ---- parseLine (simplified: no mode, just extract command) ----
assert.deepEqual(parseLine("ls -la"), { kind: "ok", command: "ls -la" });
assert.deepEqual(parseLine(" ls -la"), { kind: "ok", command: "ls -la" }, "leading whitespace");
assert.deepEqual(parseLine("echo  a  b"), { kind: "ok", command: "echo  a  b" }, "internal spacing preserved");
assert.deepEqual(parseLine("git log --oneline"), { kind: "ok", command: "git log --oneline" });

assert.deepEqual(parseLine(""), { kind: "usage" });
assert.deepEqual(parseLine("   "), { kind: "usage" });

// ---- formatSummary ----
assert.equal(formatSummary("echo hi"), "$ echo hi");
const long = "x".repeat(200);
assert.ok(formatSummary(long).length <= 120, "summary bounded");
assert.ok(formatSummary(long).endsWith("…"), "summary truncation marker");

// ---- formatResult ----
function outcome(overrides = {}) {
	return {
		command: "echo hi",
		stdout: { text: "hi\n", truncated: false },
		stderr: { text: "", truncated: false },
		exitCode: 0,
		signal: null,
		timedOut: false,
		cancelled: false,
		timeoutMs: 60000,
		...overrides,
	};
}

assert.equal(
	formatResult(outcome()),
	"$ echo hi\nhi\n[exit code 0]",
	"stdout-only success",
);
assert.equal(
	formatResult(outcome({ stdout: { text: "", truncated: false }, exitCode: 0 })),
	"$ echo hi\n[exit code 0]",
	"empty stdout",
);
assert.equal(
	formatResult(outcome({ stdout: { text: "", truncated: false }, stderr: { text: "boom\n", truncated: false }, exitCode: 1 })),
	"$ echo hi\n— stderr —\nboom\n[exit code 1]",
	"stderr + non-zero exit",
);
assert.equal(
	formatResult(outcome({ stdout: { text: "tail", truncated: true }, exitCode: 0 })),
	"$ echo hi\ntail\n…[stdout truncated]…\n[exit code 0]",
	"truncated stdout",
);
assert.match(formatResult(outcome({ timedOut: true, exitCode: null, signal: "SIGTERM" })), /\[timed out after 60000ms\]$/);
assert.match(formatResult(outcome({ cancelled: true, exitCode: null, signal: "SIGTERM" })), /\[cancelled\]$/);
assert.match(formatResult(outcome({ exitCode: null, signal: "SIGKILL" })), /\[terminated by SIGKILL\]$/);

console.log("UNIT TESTS PASSED");
