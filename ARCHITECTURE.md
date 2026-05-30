# Architecture

This project is local-first. The browser UI talks to a local Node server which spawns a PTY to run a command/agent CLI inside a repository, persists session/log history to SQLite, and streams live output back over WebSockets.

```mermaid
flowchart TB
  UI[Browser UI (React + Vite)]
  S[Local server (Node + Express)]
  DB[(SQLite: data/agents_fleet.sqlite)]
  PTY[PTY runner (local command/agent CLI)]
  REPO[Local repository]

  UI -->|HTTP: /api/sessions, /api/sessions/:id/logs| S
  UI <-->|WebSocket: /ws (live output + status)| S
  S -->|persist sessions + logs| DB
  S -->|spawn + manage| PTY
  PTY -->|runs in cwd| REPO
  PTY -->|PTY output stream| S
```

## Notes
- Interactive agent CLIs (e.g. Claude Code) render a full-screen TUI via ANSI escape codes. The UI uses xterm.js to render the live PTY stream.
- Persisted logs are line-based and useful for auditing/search, but they are not a perfect replay of a full-screen terminal UI.
