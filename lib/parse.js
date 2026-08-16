/**
 * dsh-shell-command — command-line parsing, dependency-free so unit tests can
 * import it without the harness runtime.
 *
 * @module dsh-shell-command/parse
 */

export const USAGE = "Usage: /! <command>";

/**
 * Extract the command from a '/!' shell command line.
 *
 * @param rawInput - exact text after the '/!' prefix (e.g., "ls -la").
 * @returns `{kind:'ok', command}` or `{kind:'usage'}`.
 */
export function parseLine(rawInput) {
	const trimmed = rawInput.trim();
	if (trimmed.length === 0) return { kind: "usage" };
	return { kind: "ok", command: trimmed };
}
