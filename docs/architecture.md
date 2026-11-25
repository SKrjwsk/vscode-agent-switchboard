# Architecture

## Data sources

- **Transcripts** `~/.claude/projects/<encoded path>/<uuid>.jsonl` — one file per session. Files not named by a UUID are skipped. The first 256 KB give the folder (`cwd`) and the first prompt; once both are found, this head is cached for good. The last 1 MB is searched only for lines with `"customTitle"` (written by `/rename`). Claude Code deletes transcripts after `cleanupPeriodDays` (30 by default), so sessions and favorites disappear with them.
- **Session files** `~/.claude/sessions/<pid>.json` — written by Claude Code for every running process: `pid`, `sessionId`, `cwd`, `name`, `status` and more. `status` maps to the state: `busy` → working, `waiting` → needs approval (`waitingFor` is shown in the tooltip, e.g. `permission prompt`), `idle` → your turn, or dormant once `statusUpdatedAt` (ms) is 30 minutes or more old (`YOUR_TURN_WINDOW_MS` in `session-status.js`; an idle file without a usable time stays your turn). The state is computed on every refresh, so a session turns dormant without a file change. Any other `status` leaves the icon in the theme color. Only needs approval is counted by the badge. After `/clear` the file carries the id of the new session. A crashed process leaves its file behind, so only files with a live pid count.
- **Processes** `ps -axo pid=,ppid=,lstart=,command=` with `LC_ALL=C` and a 2 s timeout — start time and parent chain. A pid from a session file counts only when `ps` shows it as a `claude` process; otherwise a stale file whose pid was reused by another program would show up.
- **VS Code terminals** `terminal.processId` — the pid of the terminal's shell. A `claude` process belongs to the terminal found by walking up its parents (it can sit a few levels below the shell).

## Session titles

1. `/rename` title (`customTitle` in the end of the transcript)
2. First user prompt; skipped: system-injected messages (starting with `<`), an injected skill body, slash commands without arguments (`/model`, `/clear`). A command with arguments becomes `/command arguments`
3. For a running process without a transcript yet: the name given with `claude -n`, then `claude (pid N)`

Titles are cleaned: configured path prefixes cut, home directory shown as `~`, `[Image #N]` removed, at most 70 characters.

## Modules

- `extension.js` — activation, refresh timers, commands and actions (resume, new session, transcript preview, copy, close, search, double click)
- `session-model.js` — one shared snapshot of sessions, states and processes; views only render it
- `views.js` — the three tree views, items (descriptions, tooltips, icons, `contextValue`) and label colors
- `session-files.js` — reading and caching transcripts, titles
- `session-status.js` — reading `~/.claude/sessions/<pid>.json`
- `running-sessions.js` — processes, their sessions and owning VS Code terminals
- `favorites.js` — favorite session ids in `globalState`
- `folder-tree.js` — folder tree of sessions
- `transcript.js` — transcript rendered as Markdown
- `workspace.js` — workspace filter and paths relative to the workspace folder

`session-files`, `session-status`, `running-sessions`, `folder-tree` and `transcript` do not use the `vscode` API and run in plain Node.js. Their tests in `test/` use `node:test` against a temporary home directory (`npm test`); `npm run lint` runs ESLint.

## Refresh

- Every 3 s, only while the window is focused and a view is visible: session files, processes, and only the transcripts of active sessions. All transcripts are listed every 30 s, or at once when a session file names a session not on the list
- Immediate full scan: window regains focus, a view becomes visible, a terminal closes, Refresh command, 3 s after a terminal opens
- Render without a scan: active terminal, workspace folders or favorites change

## Design decisions

- **Polling, not events.** Sessions started or closed in another terminal and state changes give VS Code no event. Polling runs only in the focused window with a visible view, so several VS Code windows do not scan in parallel.
- **One shared model.** Three views read one snapshot scanned once per cycle. Views re-render only when the visible data changes (a fingerprint of the snapshot); re-rendering every cycle would close open tooltips and multiply I/O by the number of views.
- **Exact process-to-session match.** Claude Code names the session of each pid in its session file. The alternatives are worse: guessing from command-line flags fails for sessions started without `--resume`, and a status hook would have to be installed in the user's Claude Code settings.
- **Partial reads.** Transcripts grow to hundreds of MB; reading the head once and the tail on change keeps a scan cheap.
- **Terminals as editor tabs.** Sessions open in the first editor group, next to the code, instead of the terminal panel.
- **No runtime dependencies, no build.** Plain CommonJS against the VS Code API keeps the package small and the code readable as shipped.

## Favorites storage

A list of session ids in `context.globalState` (key `favoriteSessionIds`): shared by all windows and projects, kept across extension updates, synced by Settings Sync, removed with the extension.
