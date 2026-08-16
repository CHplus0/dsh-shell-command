# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin. It adds a `/shell` slash command (run one command, show output, optionally hand it to the model for analysis) and a `/terminal` command (interactive PTY popup with an exit-time consent gate) to the DSH web GUI. Conceptually this mirrors Claude Code's `!` gesture, split into explicit modes since a bare `!` prefix isn't practical in a chat input box.

Not a git repository (no `.git`) — this is a working checkout, not something to run `git log`/`git diff` against for history.

## Commands

```sh
node test/unit.mjs           # pure parse/format tests, no dependencies
node test/smoke.mjs          # full apply() + handler against a mock context
node test/smoke-terminal.mjs # terminal registry + inject + close-consent RPC (mock)
```

There is no build step (`lib/client.js` is hand-authored, no bundler) and no lint script configured in `package.json`.

The smoke tests import the real `@deepseek-ai/*` peer packages. Outside of a DSH profile install, link them once:

```sh
mkdir -p node_modules/@deepseek-ai
ln -s "$HOME/.dsh/profiles/node_modules/@deepseek-ai/"* node_modules/@deepseek-ai/
```

To exercise the plugin live, install it into a profile (`dsh plugin --profile web add "link:/path/to/dsh-shell-command"`) and restart `dsh web`.

## Architecture

### Two independent host-side execution paths

1. **Single-command (`/shell`)** — `lib/index.js` registers the command via `ctx.commands.register`. Handler flow: `parse.js` → `exec.js` → `format.js`, and in analyze mode, `message.js` → `agent.followup`. This path only needs the `commands` service; it works even if terminal mode is disabled or unavailable.
2. **Multi-command terminal (`/terminal`)** — assembled by `setupTerminalMode` in `lib/rpc.js`, which lazily imports `node-pty` and `ws`. If those (or the `connection`/`agents`/`webServer` services) are missing, terminal mode disables itself with a warning and the `/shell` path stays fully functional. Never let a terminal-mode failure take down the whole plugin — this degrade-gracefully contract is intentional, preserve it when editing `rpc.js`.

`/terminal` is a **separate** top-level command, not a `/shell --terminal` flag — it was originally planned as a flag but that collided with the host command directory's `matchEnter` claim priority (registered earlier, higher priority), documented in `开发进度.md`.

### Mode parsing (`lib/parse.js`)

Only the **first whitespace-delimited token** of the raw input is checked against `-a`/`--analyze`/`-d`/`--display`. Everything after that is the verbatim command line, unparsed. This means `/shell ls -a` runs `ls -a` (the command's own flag), while `/shell -a ls` analyzes `ls`. Do not "improve" this into full argv parsing — the single-token check is what keeps a command's own flags from being misread as plugin flags.

### Execution backends (`lib/exec.js`)

`runCommand` has two backends behind one normalized outcome shape:
- `ctx.subprocess` (harness-managed seam, preferred when present): scrubbed environment, tree-scoped `SIGTERM → grace → SIGKILL`, bounded tail-retaining stream collection.
- `node:child_process` fallback (used when the seam is absent): scrubbed env via `scrubbedParentEnv()` from `@deepseek-ai/dsh-subprocess`, in-memory bounded buffers, process-level (not tree-level) kill.

Timeout vs. cancellation is always classified from the caller-owned `AbortSignal`s (`timeoutSignal.aborted` / `signal.aborted`), never inferred from exit code/signal — keep that ordering if you touch the outcome-normalization tail of `runCommand`.

### Terminal mode data flow (`lib/terminal.js` + `lib/rpc.js`)

One persistent PTY per session (`sessionId` → `TerminalHandle`), owner-scoped, with a bounded in-memory transcript that backs both the live WebSocket replay and exit-time injection:

- `connection.rpc` control channel (`/shell-term-rpc`): `open` / `transcript` / `close`.
- `ctx.webServer.registerUpgrade` WebSocket (`/shell-term/ws`) for the live byte stream; connecting replays the current transcript first.
- On `close`, the transcript is **always** persisted to `<workspace>/<terminalTranscriptDir>/` (pruned to `terminalTranscriptKeep` files per session), independent of the consent choice.
- Consent gate (`lib/inject.js`): `inject: true` → `buildFollowupMessage` (bounded-tail, ANSI-stripped transcript + optional user notes) via `agent.followup` — wakes the model synchronously. `inject: false` → `buildPointerMessage` via `agent.inject` — a one-line non-waking pointer to the persisted file for the model to read on a later turn.

### Messages sent to the model (`lib/message.js`, `lib/inject.js`)

Every message built for `agent.followup`/`agent.inject` carries `source: { kind: "plugin", plugin: "shell-command", form: "notice", summary }`. This label is load-bearing — an unlabeled message renders as an ordinary user prompt in derived history instead of a plugin-sourced notice. Preserve it on any new message constructor.

### Client bundle (`lib/client.js`)

Hand-authored, no build step, loaded via `window.__ModuleLoader__.load`. Registers the `/terminal` input trigger (must implement the full `candidates`/`onPick`/`matchSpace`/`matchEnter` contract — `matchEnter` must return a Promise), renders the terminal popup as React mounted on the `conversation.input.dock` slot, and does its own minimal ANSI/SGR-to-`<span>` color rendering (`renderAnsi`) rather than pulling in a terminal-emulation library. It's currently line-oriented (scrollback + input line), not full VT100/xterm — `vim`/`htop`/progress bars/`resize` are known-unsupported, with an xterm.js migration noted as the follow-up in `开发进度.md`.

### Config

All config flows through the single `schemastery` `Config` object in `lib/index.js`, applied via the profile's `cordis.patch.yml` (`cordis.patch.yml` in this repo root is the *shipped default* patch documenting every key; profile-level overrides replace a row's entire `config`, so restating the complete config on override is required, not optional).

## Non-obvious constraints

- Everything runs with the host's own OS privileges — there is no sandbox/approval step by design (same trust model as a user typing directly into their own terminal). Command text is still recorded to the trajectory (`command/run`) for auditability.
- Output/transcript bounding always retains the **tail**, not the head, on overflow (`maxOutputBytes`, `terminalMaxTranscriptBytes`, `terminalInjectMaxBytes` — three independent caps for three different surfaces).
- `.dsh-shell-transcripts/` (persisted terminal transcripts) is already gitignored; don't assume it stays empty in a working checkout.
