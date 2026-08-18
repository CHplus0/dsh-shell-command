# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) plugin. It adds:

1. A `/!` command (run one shell command, analyze output, inspired by Claude Code's `!` gesture)
2. A `/terminal` command (interactive PTY popup; transcripts persist automatically when the session received input, and are referenced into the model on demand from a history tab — closing never itself sends anything to the model)

**Note**: DSH's input trigger system only supports `/` and `@` as trigger characters (hardcoded in `dsh-client-ui-input-trigger/lib/types/types.d.ts`). We cannot use a bare `!` prefix like Claude Code does, so we use `/!` instead.

Not a git repository (no `.git`) — this is a working checkout, not something to run `git log`/`git diff` against for history.

## Commands

```sh
node test/unit.mjs           # pure parse/format tests, no dependencies
node test/smoke.mjs          # full apply() + handler against a mock context
node test/smoke-terminal.mjs # terminal registry + hasInput tracking + history-reference RPC (mock)
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

One persistent PTY per session (`sessionId` → `TerminalHandle`), owner-scoped, with a bounded in-memory transcript that backs both the live WebSocket replay and later on-demand history reference:

- `connection.rpc` control channel (`/shell-term-rpc`): `open` / `transcript` / `close` / `historyList` / `historyRead` / `historyInject`.
- `ctx.webServer.registerUpgrade` WebSocket (`/shell-term/ws`) for the live byte stream; connecting replays the current transcript first.
- `close` never sends anything to the model — it is a pure persistence step. A session is only persisted if it actually received input: `TerminalHandle.hasInput` is set in both `attachWs`'s WebSocket message handler and the exported `write()` fallback (the real production input path is the WS handler; `write()` is the test/non-WS route). A PTY prints its shell banner/prompt unprompted, so `transcript` being non-empty does *not* mean the user did anything — `hasInput` is the real signal. A session that never received input leaves zero trace: no persisted file, no `.meta.json` sidecar, no entry in `manager.list()`.
- When a session did receive input, its transcript persists to `<workspace>/<terminalTranscriptDir>/` (pruned to `terminalTranscriptKeep` files per session), alongside a `.meta.json` sidecar (`{ timestamp, exitCode, truncated }`) that backs the history tab's list view. The filename carries a zero-padded per-manager counter (`<sessionId>-<isoStamp>-<counter>`) so two closes landing in the same millisecond don't collide and silently overwrite each other's transcript+sidecar; `list()`/`prune()` both sort on this filename, so the padding also keeps sort order agreeing with persist order past the 10th same-millisecond collision. `list()` tolerates pre-existing `.log` files with no sidecar (from before history mode shipped) by falling back to file stat + `exitCode: null`.
- On the client, `TerminalController.exit()` ends the PTY and, based on `close`'s result, either returns to `closed` (empty session, panel disappears) or enters `ended` (panel stays open, jumps to the `history` tab, and pre-selects the just-persisted entry via `pendingSelectPath` — see `lib/client.js`). Whether to feed that transcript to the model is left entirely to the user, via the history tab's existing "引用并分析" action.
- History reference (`lib/client.js`'s 历史 tab, "引用并分析"): `historyInject` takes an array of transcript paths (validated against `manager.list()` for that session — a client can only reference its own session's transcripts, not arbitrary paths) plus free-form notes, and wakes the model synchronously: notes via `agent.inject`, pointer via `agent.followup`. The pointer (`buildHistoryPointerMessage`) stays content-free (paths/timestamps/exit codes, no transcript text) since a rerun between persist time and read time may have produced different output; the model has to actually read the referenced files. This is the *only* path in the plugin that ever sends a terminal transcript into the model's context — closing a `/terminal` session never does, regardless of whether it received input.
- **Why `agent.inject` before `agent.followup` produces one wake, not two, and why the pair still lands as two ordinary bubbles**: `agent.followup` opens a brand-new turn and wakes the model — calling it twice would mean two separate model replies, so the user's notes can never themselves go through `followup`. `agent.inject` queues its message for the *next step* without waking anything. `dsh-agent`'s `Inbox.claim()` pulls the next-step queue first, then the next-turn item, and folds them into one `user/message` batch for that turn's first step — so an `inject` call placed immediately before a `followup` call rides in as a distinct message in the same wake, not a second wake. `buildHistoryNotesMessage` (the message constructor that carries the user's own words) uses `source: { kind: "user" }` instead of the plugin-notice shape (see below), so it renders as an ordinary chat bubble — it falls back to a default account (`请帮我对比分析这些历史终端记录。`) when the user left the field empty.

### Messages sent to the model (`lib/message.js`, `lib/inject.js`, `lib/util.js`)

Two message shapes, chosen by what a message *is*, not by which API sent it:
- `buildPluginMessage` (`lib/util.js`) carries `source: { kind: "plugin", plugin: "shell-command", form: "notice", summary }` — a plugin-authored account of something that happened (a transcript, a pointer to a file). This label is load-bearing — an unlabeled message renders as an ordinary user prompt in derived history instead of a plugin-sourced notice.
- `buildUserMessage` (`lib/util.js`) carries `source: { kind: "user" }` — reserved for the user's *own words* (typed into a notes field), so it renders as a normal chat bubble rather than a notice row. Mirrors the precedent in `dsh-plan-mode`'s `/plan <text>` handling. Never use this shape for plugin-authored text; that would misrepresent the message's origin in derived history.

Preserve the `source` shape on any new message constructor — it's what the client UI (`dsh-client-ui-conversation`) keys off to choose `UserStyleBubble` vs. `ContextInjectionRow` rendering.

### Client bundle (`lib/client.js`)

Hand-authored, no build step, loaded via `window.__ModuleLoader__.load`. Registers both input trigger sources described above. The terminal popup is `ReactDOM.createPortal`-rendered to `document.body` (not inline in the `conversation.input.dock` slot — that slot only mounts the component once per session so its lifecycle stays scoped to the session) as a freely movable/resizable floating panel: `position: fixed`, a draggable header, and a corner resize grip, with geometry clamped to the viewport and a minimum size, held in `TerminalController`'s snapshot state. It does its own minimal ANSI/SGR-to-`<span>` color rendering (`renderAnsi`) rather than pulling in a terminal-emulation library — this also strips OSC sequences (e.g. bash's window-title `\x1b]0;...\x07`) before the CSI/SGR tokenizer runs, mirroring `stripAnsi` in `inject.js`, so a shell's title-set escape doesn't render as garbled text ahead of the real prompt. It's currently line-oriented (scrollback + input line), not full VT100/xterm — `vim`/`htop`/progress bars/`resize` are known-unsupported, with an xterm.js migration noted as the follow-up in `开发进度.md`.

The panel has two tabs: **会话** (live PTY scrollback + input line while a session is open; a read-only final scrollback with no input row once `ended`) and **历史** (past `/terminal` sessions for this session id, read via `historyList`/`historyRead`, multi-select checkboxes + a notes textarea + "引用并分析", calling `historyInject`). Clicking the header's "退出" button ends the PTY (no consent prompt) — a non-empty close lands in `ended` with the history tab pre-selecting the just-closed entry (`pendingSelectPath`, consumed by `HistoryTab`'s `selected` state initializer on mount) and auto-expanding its preview (via a mount-time `useEffect` calling `controller.togglePreview`); the same header slot then reads "关闭面板" to dismiss the panel outright. The history tab's footer also offers a "直接退出，本次不分析" button next to "引用并分析", calling `controller.dismiss()` directly — it's gated to `state.status === "ended" || "error"` (same condition as the header's "关闭面板" label) since `dismiss()` only tears down client-side UI state and never calls the close RPC; surfacing it while a PTY is still `open` would let a user believe they'd skipped a session that's actually still running server-side. The notes textarea includes a small-text hint below it showing the default message used when notes are left blank: "请帮我分别分析这些历史终端记录。" (changed from "对比分析" to "分别分析" per user feedback). History entries never carry embedded transcript content into the model context by default — `historyInject` builds a pointer-only message (paths + timestamps + exit codes + your notes) via `agent.inject` (non-waking), explicitly labeled as historical so the model doesn't mistake it for a just-happened event; a rerun of the same command may produce different output by the time it's read.

The input line supports ArrowUp/ArrowDown recall of previously-submitted lines for that terminal window (`TerminalController.submittedLines`, capped at 500 entries, populated by `send()`), entirely client-side — it never touches the PTY. This is deliberate, not a shortcut: input is sent as whole lines on Enter rather than keystroke-by-keystroke, so there's no server-side readline buffer this client is in sync with; forwarding raw arrow-key bytes to the PTY the way Ctrl+C/D/Z bytes are forwarded would recall history into the *PTY's* echo (rendered in scrollback) while the local draft box stayed unchanged, producing a visible desync between what's shown and what Enter would submit. `submittedLines` persists across open/close (unlike `this.transcript`, which is server PTY content and does reset) since it represents the user's own typed history for this terminal window. Tab-completion is not supported for the same reason (it depends on server-side filesystem state a pure client-side recall can't have) and left as a known limitation alongside the VT100/xterm gaps below.

### Config

All config flows through the single `schemastery` `Config` object in `lib/index.js`, applied via the profile's `cordis.patch.yml` (`cordis.patch.yml` in this repo root is the *shipped default* patch documenting every key; profile-level overrides replace a row's entire `config`, so restating the complete config on override is required, not optional).

## Non-obvious constraints

- Everything runs with the host's own OS privileges — there is no sandbox/approval step by design (same trust model as a user typing directly into their own terminal). Command text is still recorded to the trajectory (`command/run`) for auditability.
- Output/transcript bounding always retains the **tail**, not the head, on overflow (`maxOutputBytes`, `terminalMaxTranscriptBytes` — independent caps for two different surfaces).
- `.dsh-shell-transcripts/` (persisted terminal transcripts) is already gitignored; don't assume it stays empty in a working checkout.
