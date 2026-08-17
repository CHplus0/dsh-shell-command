# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin. It adds:

1. A `/!` command (run one shell command, analyze output, inspired by Claude Code's `!` gesture)
2. A `/terminal` command (interactive PTY popup with an exit-time consent gate)

**Note**: DSH's input trigger system only supports `/` and `@` as trigger characters (hardcoded in `dsh-client-ui-input-trigger/lib/types/types.d.ts`). We cannot use a bare `!` prefix like Claude Code does, so we use `/!` instead.

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

### Two independent execution paths

1. **Single-command (`/!`)** — Client-side input trigger (lib/client.js) registers under `trigger: "/"`, name-matched to `!` (candidates/matchSpace/matchEnter all key off the literal `/!` token). Handler flow: user types `/! ls` → client calls RPC `/shell-bang-rpc` → host (lib/index.js) does `parse.js` → `exec.js` → `format.js` → `message.js` → `agent.followup`. This path requires `connection` and `agents` services. It checks `agent.session.requestHeader()` — if the session has no model request context yet, it refuses with an error message (mirroring dsh-btw behavior).

2. **Multi-command terminal (`/terminal`)** — assembled by `setupTerminalMode` in `lib/rpc.js`, which lazily imports `node-pty` and `ws`. If those (or the `connection`/`agents`/`webServer` services) are missing, terminal mode disables itself with a warning and the `/!` path stays fully functional. Never let a terminal-mode failure take down the whole plugin — this degrade-gracefully contract is intentional, preserve it when editing `rpc.js`.

`/terminal` and `/!` are both registered under `trigger: "/"` with distinct `name`s — DSH's input trigger system only supports `/` and `@` as physical trigger characters (see `TriggerChar` in `dsh-client-ui-input-trigger`), so a bare `!` prefix is not possible.

### Mode parsing (`lib/parse.js`)

Simplified: only extracts the command text from the input. No mode flags anymore — the `/!` trigger always analyzes output (that's its purpose).

### Client-side input triggers (`lib/client.js`)

Two input trigger sources registered via `inputTriggers.registerSource`:

1. **`/!` command trigger** (`createBangSource`): `trigger: "/"`, `name: "shell-bang"`, implements `candidates`/`onPick`/`matchSpace`/`matchEnter`. Candidates filter: only shows when `request.query` starts with `!`. On submit, calls RPC `/shell-bang-rpc` with the command text. The RPC result determines success/error shown to the user.

2. **`/terminal` trigger** (`createTerminalSource`): `trigger: "/"`, `name: "terminal"`, name-matched to `/terminal`. Implements the full contract, `matchEnter` returns a Promise. Opens the terminal popup via `TerminalController.open()`.

### Execution backends (`lib/exec.js`)

`runCommand` has two backends behind one normalized outcome shape:
- `ctx.subprocess` (harness-managed seam, preferred when present): scrubbed environment, tree-scoped `SIGTERM → grace → SIGKILL`, bounded tail-retaining stream collection.
- `node:child_process` fallback (used when the seam is absent): scrubbed env via `scrubbedParentEnv()` from `@deepseek-ai/dsh-subprocess`, in-memory bounded buffers, process-level (not tree-level) kill.

Timeout vs. cancellation is always classified from the caller-owned `AbortSignal`s (`timeoutSignal.aborted` / `signal.aborted`), never inferred from exit code/signal — keep that ordering if you touch the outcome-normalization tail of `runCommand`.

### RPC handling (`lib/index.js`)

The `/!` trigger's RPC handler (`/shell-bang-rpc`) is registered via `connection.rpc.handle`. It:
1. Resolves the agent from the session ID.
2. Checks `agent.session.requestHeader()` — if undefined, rejects with "No model request exists yet. Send a message before using /! commands."
3. Parses the command (via `parse.js`), runs it (via `exec.js`), formats the output (via `format.js`), and injects the analysis message (via `message.js` and `agent.followup`).

This design aligns with dsh-btw: the trigger only works in sessions that have already sent a model request, which naturally avoids the UI rendering-timing bug that affected the old `/shell` display mode.

### Terminal mode data flow (`lib/terminal.js` + `lib/rpc.js`)

One persistent PTY per session (`sessionId` → `TerminalHandle`), owner-scoped, with a bounded in-memory transcript that backs both the live WebSocket replay and exit-time injection:

- `connection.rpc` control channel (`/shell-term-rpc`): `open` / `transcript` / `close` / `historyList` / `historyRead` / `historyInject`.
- `ctx.webServer.registerUpgrade` WebSocket (`/shell-term/ws`) for the live byte stream; connecting replays the current transcript first.
- On `close`, the transcript is **always** persisted to `<workspace>/<terminalTranscriptDir>/` (pruned to `terminalTranscriptKeep` files per session), independent of the consent choice, alongside a `.meta.json` sidecar (`{ timestamp, exitCode, truncated, injected }`) that backs the history tab's list view. The filename carries a zero-padded per-manager counter (`<sessionId>-<isoStamp>-<counter>`) so two closes landing in the same millisecond don't collide and silently overwrite each other's transcript+sidecar; `list()`/`prune()` both sort on this filename, so the padding also keeps sort order agreeing with persist order past the 10th same-millisecond collision. `list()` tolerates pre-existing `.log` files with no sidecar (from before history mode shipped) by falling back to file stat + `exitCode: null`.
- Consent gate (`lib/inject.js`): `inject: true` → `buildFollowupMessage` (bounded-tail, ANSI-stripped transcript + optional user notes) via `agent.followup` — wakes the model synchronously. `inject: false` → `buildPointerMessage` via `agent.inject` — a one-line non-waking pointer to the persisted file for the model to read on a later turn. `buildFollowupMessage` names its own `transcriptPath` and explicitly tells the model not to cross-reference other terminal sessions' history/pointer messages still sitting in the conversation — without that line a prior session's "you may read this file if needed" pointer (from an earlier `inject: false` close) reads as a standing, unscoped permission, and the model will go dig up and blend in transcripts the user never asked about for *this* close.
- History reference (`lib/client.js`'s 历史 tab): `historyInject` takes an array of transcript paths (validated against `manager.list()` for that session — a client can only reference its own session's transcripts, not arbitrary paths) plus free-form notes, and sends `buildHistoryPointerMessage` via `agent.inject` — always non-waking, and always pointer-only (no transcript content embedded), since a rerun between persist time and read time may have produced different output.

### Messages sent to the model (`lib/message.js`, `lib/inject.js`)

Every message built for `agent.followup`/`agent.inject` carries `source: { kind: "plugin", plugin: "shell-command", form: "notice", summary }`. This label is load-bearing — an unlabeled message renders as an ordinary user prompt in derived history instead of a plugin-sourced notice. Preserve it on any new message constructor.

### Client bundle (`lib/client.js`)

Hand-authored, no build step, loaded via `window.__ModuleLoader__.load`. Registers both input trigger sources described above. The terminal popup is `ReactDOM.createPortal`-rendered to `document.body` (not inline in the `conversation.input.dock` slot — that slot only mounts the component once per session so its lifecycle stays scoped to the session) as a freely movable/resizable floating panel: `position: fixed`, a draggable header, and a corner resize grip, with geometry clamped to the viewport and a minimum size, held in `TerminalController`'s snapshot state. It does its own minimal ANSI/SGR-to-`<span>` color rendering (`renderAnsi`) rather than pulling in a terminal-emulation library — this also strips OSC sequences (e.g. bash's window-title `\x1b]0;...\x07`) before the CSI/SGR tokenizer runs, mirroring `stripAnsi` in `inject.js`, so a shell's title-set escape doesn't render as garbled text ahead of the real prompt. It's currently line-oriented (scrollback + input line), not full VT100/xterm — `vim`/`htop`/progress bars/`resize` are known-unsupported, with an xterm.js migration noted as the follow-up in `开发进度.md`.

The panel has two tabs: **会话** (live PTY scrollback + input line) and **历史** (past `/terminal` sessions for this session id, read via `historyList`/`historyRead`, multi-select checkboxes + a notes textarea + "引用注入", calling `historyInject`). History entries never carry embedded transcript content into the model context by default — `historyInject` builds a pointer-only message (paths + timestamps + exit codes + your notes) via `agent.inject` (non-waking), explicitly labeled as historical so the model doesn't mistake it for a just-happened event; a rerun of the same command may produce different output by the time it's read.

### Config

All config flows through the single `schemastery` `Config` object in `lib/index.js`, applied via the profile's `cordis.patch.yml` (`cordis.patch.yml` in this repo root is the *shipped default* patch documenting every key; profile-level overrides replace a row's entire `config`, so restating the complete config on override is required, not optional).

## Non-obvious constraints

- Everything runs with the host's own OS privileges — there is no sandbox/approval step by design (same trust model as a user typing directly into their own terminal). Command text is still recorded to the trajectory (`command/run`) for auditability.
- Output/transcript bounding always retains the **tail**, not the head, on overflow (`maxOutputBytes`, `terminalMaxTranscriptBytes`, `terminalInjectMaxBytes` — three independent caps for three different surfaces).
- `.dsh-shell-transcripts/` (persisted terminal transcripts) is already gitignored; don't assume it stays empty in a working checkout.
