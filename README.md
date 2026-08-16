# dsh-shell-command

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that adds a `/shell` slash command to the web GUI — the Claude Code `!` gesture, split into single-command and multi-command modes:

| Command | Behavior |
|---|---|
| `/shell <command>` | Run the command in the session workspace and show its output as a conversation flow node. The model does **not** analyze it. |
| `/shell --analyze <command>` | Run + show the output, then hand the transcript to the model for synchronous analysis in a new turn. |
| `/terminal` | Open an interactive terminal popup. On exit, a consent gate asks whether to inject the transcript (optionally plus your own notes) for analysis. |

Only the **first** token is inspected for a mode flag, so a command's own flags are never misread: `/shell ls -a` runs `ls -a` (display mode), while `/shell -a ls` analyzes `ls`. A bare `/shell <cmd>` uses `defaultMode` (default `display`).

## Install

Requires the `dsh` CLI and Node `>= 22`.

```sh
# from a registry / npm
dsh plugin --profile web add dsh-shell-command

# from a local checkout (live link for development)
dsh plugin --profile web add "link:/path/to/dsh-shell-command"
```

Restart the web surface once (`dsh web`) so the host-side command loads. It appears in the input `/` menu automatically.

## Modes

- **display** (`/shell <cmd>`, or `-d`/`--display`): output only. The command lifecycle (`command/run`/`command/done`) is logged to the session trajectory; the model never sees it.
- **analyze** (`/shell --analyze <cmd>`, or `-a`): output is also injected as a plugin-sourced user message via `agent.followup`, so a fresh turn analyzes it.
- **terminal** (`/terminal`): an interactive PTY popup (persistent shell, live WebSocket stream). On exit you choose:
  - **Don't inject** → the transcript is persisted to `<workspace>/.dsh-shell-transcripts/` and a non-waking pointer is injected, so the model can read it on a later turn.
  - **Inject** → optionally add a natural-language note; the transcript (bounded tail) + your note is delivered via `agent.followup` for immediate analysis.

### Terminal mode notes

- The popup is a line-oriented terminal (monospace scrollback + input line); full VT100/xterm fidelity (vim, htop) is a planned follow-up.
- The transcript directory is gitignore-friendly — add `.dsh-shell-transcripts/` to your repo's ignore list.
- Terminal mode degrades gracefully (single-command mode stays live) when `node-pty`/`ws` or the required services are unavailable.

## Configuration

Configure through the profile's `cordis.patch.yml` (the web settings UI does not expose third-party plugin settings):

```yaml
- insert:
    - id: shell-command
      name: dsh-shell-command
      config:
        shell: ''            # '' → /bin/bash (POSIX) or cmd.exe (Windows)
        shellArgs: []        # [] → -lc (POSIX) or /d /s /c (Windows)
        timeoutMs: 60000     # hard deadline; process tree is terminated on expiry
        maxOutputBytes: 32768
        graceMs: 3000
        defaultMode: display
        analysisPrompt: ''   # '' → built-in prompt; supports {command} {cwd} {output}
        terminalEnabled: true
        terminalMaxTranscriptBytes: 1048576   # in-memory transcript cap (tail)
        terminalInjectMaxBytes: 32768         # bytes injected into the model on "yes"
        terminalTranscriptDir: '.dsh-shell-transcripts'
        terminalTranscriptKeep: 10
```

## Safety

- Runs in the session's workspace directory (`agent.session.header.cwd`).
- Uses the harness `ctx.subprocess` seam when present: scrubbed environment (no `DEEPSEEK_API_KEY`/`DSH_*` leak), tree-scoped `SIGTERM → grace → SIGKILL` termination. Falls back to `node:child_process` with a scrubbed environment otherwise.
- Output is bounded per stream (`maxOutputBytes`, tail retained) for both display and analysis.
- Human-driven by design: the command text is recorded in the trajectory (`command/run`), and there is no sandbox approval step — it runs with the host's own privileges, exactly like typing in your own terminal.

## Tests

```sh
node test/unit.mjs           # pure parse/format tests, no dependencies
node test/smoke.mjs          # full apply() + handler against a mock context
node test/smoke-terminal.mjs # terminal registry + inject + close-consent RPC (mock)
```

The smoke test imports the real `@deepseek-ai/*` peers; outside a profile, link them once:

```sh
mkdir -p node_modules/@deepseek-ai
ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai/"* node_modules/@deepseek-ai/
```

## Limitations

- The flow node renders the transcript as plain text (no syntax highlighting).
- The analyze-mode message appears as a user-role row (by design — the output is meant to be visible).
- API surface targets `@deepseek-ai/dsh` `0.1.0-rc.x`; pin peers and re-verify on DSH upgrades.

## License

MIT
