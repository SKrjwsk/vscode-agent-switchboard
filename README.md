# Agent Switchboard

A free (MIT), local session manager for Claude Code in VS Code: running and past sessions in one panel, read-only, with no hooks, no writes to `~/.claude` and no runtime dependencies.

See every running session, whether it is working or waiting for you, and resume any past session in an editor tab. Plain JavaScript, no build step.

## Features

- **Sessions from any terminal** — running sessions started outside VS Code (Ghostty, tmux, any terminal) show up too, matched from `~/.claude/sessions` without installing a hook
- **All sessions as a folder tree** — built from the directory each session was started in, history included
- **Open** — every running Claude Code process in the current workspace
  - icon color shows the state: working (green), needs approval (red, a permission prompt is open), your turn (orange, Claude finished and waits for your answer), dormant (pale orange, waiting for your answer for 30 minutes or longer)
  - a badge on the panel icon counts sessions that need approval, even when the panel is collapsed
  - click switches to the session's terminal tab; `×` closes it (asks first while Claude is working)
- **Favorites** — sessions you starred, in the order you added them
- **All** — every session, newest first
- **Resume** — double click opens `claude --resume <id>` as a terminal tab in the first editor group; if the session already runs elsewhere, you are warned before a second instance writes to the same transcript
- **Start Claude here** — new session in any folder of the tree, with an optional name (`claude -n`)
- **Read transcript** — read-only Markdown preview of a session without resuming it
- **Search** — quick pick over session titles, dates and folders
- **Copy resume command** — `cd '<folder>' && claude --resume <id>` for another terminal

All views show only sessions from the folders open in the window; a window without a folder shows everything.

## Settings

- `agentSwitchboard.titlePathPrefixes` — folder paths cut from session titles. With `["~/work/"]` a first prompt `fix ~/work/app/README.md` is shown as `fix app/README.md`. The home directory is always shown as `~`.

State colors can be changed in `workbench.colorCustomizations`: `agentSwitchboard.working`, `agentSwitchboard.needsApproval`, `agentSwitchboard.yourTurn`, `agentSwitchboard.dormant`.

## Security

The extension only reads local files and makes no network requests. Its only write is the list of favorite session ids in VS Code's extension storage, which Settings Sync copies to your other machines if you have it enabled.

- `~/.claude/projects/*/<uuid>.jsonl` — session transcripts: the first 256 KB (folder, first prompt) and the last 1 MB (`/rename` title); the last 4 MB of the file when you open "Read transcript"
- `~/.claude/sessions/<pid>.json` — one file per running Claude Code process (session id, folder, state). Only files named `<number>.json` are read; the same folder holds per-process key files (`<pid>.<hash>.key`), which the extension never opens
- `ps` — process list, to check that a pid really belongs to `claude` and to find the VS Code terminal it runs in
- `process.kill(pid, 0)` — signal 0 sends nothing; it only checks whether a process is still alive

Folder paths from session files never pass through a shell: terminals get them as the `cwd` option. Session ids are accepted only in UUID format; names and copied commands are single-quoted. The transcript preview treats the transcript as untrusted: `[`, `]` and `<` are escaped outside code blocks, so links, images and HTML from an answer are not rendered.

## Limitations

- The states come from the `status` and `waitingFor` fields of the session files, checked on Claude Code 2.1.312: `waitingFor` was seen with the value `permission prompt`; any other value, or none, also counts as needs approval. A session idle for 30 minutes or longer turns dormant on the next refresh
- Supported on macOS and Linux with POSIX shells (sh, bash, zsh). The copied resume command and the quoting of session names are not meant for fish or cmd.exe; Windows is not supported

- Session files are an internal, undocumented Claude Code format, tested on Claude Code 2.1.312. A Claude Code version that does not write `~/.claude/sessions/<pid>.json` leaves **Open** empty with a message above it; **Favorites** and **All** keep working, they read only transcripts
- Sessions running outside VS Code cannot be focused from the panel
- Terminal tabs do not change color with the session state: VS Code sets a terminal's icon and color only when it is created
- Double click is emulated (two clicks within 500 ms); tree views have no double-click event
- A workspace opened through a symbolic link does not match sessions recorded under the real path
- A `/rename` title older than the last 1 MB of a transcript is lost after a VS Code restart; the title falls back to the first prompt

## Documentation

- [Architecture and design decisions](docs/architecture.md)
- [Changelog](CHANGELOG.md)

## License

[MIT](LICENSE)
