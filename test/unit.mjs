// Dependency-free unit tests for the pure parsing and formatting helpers.
//   node test/unit.mjs
import assert from "node:assert/strict";
import { parseLine } from "../lib/parse.js";
import { formatResult, formatSummary } from "../lib/format.js";

// ---- parseLine ----
assert.deepEqual(parseLine("ls -la"), { kind: "ok", mode: "display", command: "ls -la" });
assert.deepEqual(parseLine(" ls -la"), { kind: "ok", mode: "display", command: "ls -la" }, "leading separator whitespace");
assert.deepEqual(parseLine("echo  a  b"), { kind: "ok", mode: "display", command: "echo  a  b" }, "internal spacing preserved");

assert.deepEqual(parseLine("-a ls -la"), { kind: "ok", mode: "analyze", command: "ls -la" });
assert.deepEqual(parseLine("--analyze git diff"), { kind: "ok", mode: "analyze", command: "git diff" });
assert.deepEqual(parseLine("-d ls"), { kind: "ok", mode: "display", command: "ls" });
assert.deepEqual(parseLine("--display ls"), { kind: "ok", mode: "display", command: "ls" });

assert.deepEqual(parseLine("ls -a"), { kind: "ok", mode: "display", command: "ls -a" }, "a command's own -a is never a mode flag");
assert.deepEqual(parseLine("git log --oneline"), { kind: "ok", mode: "display", command: "git log --oneline" });
assert.deepEqual(parseLine("ls", "analyze"), { kind: "ok", mode: "analyze", command: "ls" }, "defaultMode applies to bare form");

assert.deepEqual(parseLine(""), { kind: "usage" });
assert.deepEqual(parseLine("   "), { kind: "usage" });
assert.deepEqual(parseLine("-a"), { kind: "usage" }, "mode flag with no command");
assert.deepEqual(parseLine("--analyze   "), { kind: "usage" });

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
