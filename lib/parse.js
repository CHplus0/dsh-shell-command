/**
 * dsh-shell-command — command-line parsing, dependency-free so unit tests can
 * import it without the harness runtime.
 *
 * @module dsh-shell-command/parse
 */

export const USAGE = "Usage: /shell [--analyze|-a | --display|-d] <command>";

const ANALYZE_TOKENS = new Set(["-a", "--analyze"]);
const DISPLAY_TOKENS = new Set(["-d", "--display"]);
const MODE_TOKENS = new Set([...ANALYZE_TOKENS, ...DISPLAY_TOKENS]);

/**
 * Split a command line into its mode and verbatim command.
 *
 * Only the first whitespace-delimited token is inspected for a mode flag, so a
 * command's own flags (`ls -a`, `git log --oneline`) are never misread.
 *
 * @param rawInput - exact text after the command name (leading separator included).
 * @param defaultMode - config default for the bare form.
 * @returns `{kind:'ok', mode, command}` or `{kind:'usage'}`.
 */
export function parseLine(rawInput, defaultMode = "display") {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return { kind: "usage" };

	const space = trimmed.search(/\s/);
	const first = space === -1 ? trimmed : trimmed.slice(0, space);
	const rest = space === -1 ? "" : trimmed.slice(space).trimStart();

	if (MODE_TOKENS.has(first)) {
		if (rest.length === 0) return { kind: "usage" };
		return { kind: "ok", mode: ANALYZE_TOKENS.has(first) ? "analyze" : "display", command: rest };
	}

	return { kind: "ok", mode: defaultMode, command: trimmed };
}
