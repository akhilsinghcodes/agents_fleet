# Architecture

This project is local-first. The browser UI talks to a local Node server which spawns a PTY to run a command/agent CLI inside a repository, persists session + terminal history to SQLite, and streams live output back over WebSockets.

```mermaid
flowchart TB
  UI[Browser UI (React + Vite)]
  S[Local server (Node + Express)]
  DB[(SQLite: data/agents_fleet.sqlite)]
  PTY[PTY runner (local command/agent CLI)]
  REPO[Local repository]

  UI -->|HTTP: /api/sessions, /api/sessions/:id/pty| S
  UI <-->|WebSocket: /ws (live output + status)| S
  S -->|persist sessions + PTY chunks| DB
  S -->|spawn + manage| PTY
  PTY -->|runs in cwd| REPO
  PTY -->|PTY output stream| S
```

## SQLite schema (MVP)

The server persists everything to a local SQLite DB at `data/agents_fleet.sqlite`.

| Table | Purpose | Why it exists |
|---|---|---|
| `sessions` | One row per run (command + repo, timestamps, status, budgets, token/cost estimates, stop reason) | Lets the UI list sessions, show status/metadata, and enforce budgets |
| `pty_chunks` | Raw PTY output stream chunks (ANSI included) keyed by `session_id` and `timestamp` | Enables **Terminal (persisted)** by replaying through xterm.js (faithful scrollback for TUIs) |
| `stdin_events` | Audit trail of user input sent to the PTY (bounded/escaped) | Useful for debugging/auditing without corrupting terminal replay |
| `session_markers` | Important timestamps like `stop_requested`, `budget_exceeded`, `process_exit` | Supports replay UX (e.g. freezing replay before TUI cleanup) and debugging session lifecycle |
| `session_artifacts` | Per-session artifacts (e.g. git diff snapshots) keyed by `session_id` | Stores end-of-session snapshots like changed files + diff for later inspection/export |

## Notes
- Interactive agent CLIs (e.g. Claude Code, Codex) render a full-screen TUI via ANSI escape codes.
- **Terminal (live)**: rendered from the live PTY stream over WebSocket using xterm.js.
- **Terminal (persisted)**: reads `pty_chunks` from SQLite and replays through xterm.js to provide scrollback/history.
- Input auditing is stored separately (`stdin_events`) and is not injected into the terminal replay stream.
