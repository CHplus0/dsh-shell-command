# Changelog

## 0.2.0 — 2026-10-19 (release candidate)

This release candidate includes the unpublished 0.1.1 installation fixes.
GitHub Release remains a draft until the separate publishing step.

### Terminal and correctness

- Fix command timeout/cancellation escalation (including surviving child processes), UTF-8 tail retention, literal prompt placeholders, and ANSI OSC preview stripping.
- Restore the documented `/!` model-context admission check and paired command audit events. Keep `/!` available without the Web service; start terminal mode when that service becomes available.
- Persist natural terminal exits without a browser, drain final output on close, reuse saved records, and retain failed saves for retry. Reject stale history selections and isolate prefix-related session IDs during reads/pruning.
- Ignore outdated history/preview responses and handle WebSocket transport errors without an unhandled host exception. Add host and real-browser regressions for the reviewed cases.

- Fix invisible panel labels/actions in the DSH light theme by using paired host foreground/background aliases. Restore the on-screen Ctrl+C/D/Z buttons and add light/dark/fallback contrast and legacy history interaction regressions.

- Replace the line-oriented terminal with xterm.js and FitAddon: direct keystrokes, shell completion/history, IME/paste, full-screen applications, progress overwrite and PTY resize.
- Add structured WebSocket output/input/activity/exit frames while retaining legacy raw clients. Automatic protocol replies do not create empty-session history.
- Handle natural exit, stream generations, disconnect and scope disposal; preserve history references and explicit-only model analysis.
- Build the browser entry with tsdown, embed CSS, reuse host React/DSH services, and include third-party notices.
- Add protocol regressions and browser tests using real bash/PTY, optional vim/htop, and the shipped loader bundle.

### Installation and compatibility

- Add `npm run setup:local` to initialize source checkouts used by DSH's `link:` installs. Reuse host peers, refuse conflicting links, and verify runtime imports; support `--skip-install` for dependencies already restored offline.
- Mark browser-provided client peers optional and explicitly include the tested DSH `0.1.1-rc.2` peer range alongside `0.1.0-rc.6`.
- Document local dependency recovery in English and Chinese; include the setup tool and Chinese README in the npm package.
- Run the existing tests before npm publication and test local setup's failure handling and repeatability.

### Requirements and verification

- Published runtime requires Node >=22. Source builds require Node 22.18+, 24.11+, or 26+.
- Includes xterm.js 6.0.0 and FitAddon 0.11.0 with their MIT notices; React and DSH browser services remain host-provided.
- Local verification covers macOS, real bash/PTY, Chrome, vim, loader integration and package entrypoints. htop is optional and was unavailable; Windows runtime has not been tested.
- Ubuntu CI validates Node 22, 24 and 26, with the real-browser suite on Node 24. CI results are recorded with the release artifacts.
