# xterm terminal migration

Branch: `feat/xterm-terminal`; starting commit: `741bba4`.
Preserve the existing uncommitted setup, compatibility, and documentation changes.

## Implementation

1. Split browser source from the generated `lib/client.js`. Build with tsdown,
   bundle xterm/FitAddon and CSS, and retain DSH's lazy CommonJS factory wrapper.
2. Replace the line input with a persistent xterm instance. Stream input/output
   without adding newlines, preserve the instance across tab switches, and fit
   the PTY to the visible container.
3. Add validated resize RPC and opt-in structured WebSocket messages for output,
   user activity, and process exit, keeping legacy raw clients working.
4. Keep empty closes silent, preserve bounded raw transcripts/history references,
   and handle natural exit, disconnect, reopen, and disposal.
5. Update installation/build scripts, CI, and English/Chinese documentation.

## Acceptance

- Existing setup/unit/smoke tests and new host lifecycle/protocol tests pass.
- Real browser + PTY tests cover keystrokes, shell history/completion, CJK paste
  and composition, Ctrl+C/D/Z, progress overwrite, alternate screen/vim,
  resize, tab preservation, disconnect, clean reopen, and transcript history.
- Build artifact materializes through the actual DSH loader contract with
  host React/DSH externals. Package includes the browser bundle and CSS.
- Automatic terminal replies alone do not create history. Closing does not
  wake the model; explicit history references remain the sole terminal wake.

Defaults: preserve shell selection/startup, one PTY per session, existing
transcript limits and format. No registry publication is part of this task.
