# Agents Fleet (prototype)

Local-first “mission control” for AI coding agent CLIs (and any shell commands): launch sessions in a repo, stream live output to a web UI, stop them, and keep a persisted history.

This repository contains a **working MVP**:
- pnpm workspace monorepo
- React + Vite + TypeScript “Mission Control” web app
- Node + Express + TypeScript server:
  - SQLite persistence (`data/agents_fleet.sqlite`)
  - session + logs HTTP APIs
  - WebSocket live log streaming (`/ws`)
- shared TypeScript types (`packages/shared`)

## Demo

### Screenshots

**New session form**

![New session form](screenshots/New_Session.png)

**Live terminal (interactive agents)**

- Claude Code (interactive TUI rendered via xterm.js)

![Claude interactive session](screenshots/claude.png)

- OpenAI Codex (interactive)

![Codex interactive session](screenshots/codex.png)

**Live output vs persisted logs**

- Terminal (live)

![git status live](screenshots/git_status_live.png)

- Logs (persisted)

![git status persisted logs](screenshots/git_status_logs.png)

**Budget enforcement (auto-stop)**

- Token budget cutoff

![Token budget cutoff](screenshots/cutoff_based_on_tokens.png)

- USD budget cutoff

![USD budget cutoff](screenshots/cutoff_based_on_cost.png)

**Cost estimate vs actual (CLI-reported)**

![Claude actual cost vs estimate](screenshots/claude_Actual_cost_vs_estimate.png)

**SQLite persistence (debug views)**





### Videos

> Tip: GitHub renders MP4 previews nicely in README. `.mov` files are ignored by default in `.gitignore` to avoid bloating git history.

- `screenshots/Agents_Fleet__Mission_Control_for_Your_Local_AI_Workers.mp4`

## Architecture
See `ARCHITECTURE.md`.



## Prerequisites
- Node.js 20.x
- pnpm (Corepack is fine)

## Setup
```bash
COREPACK_HOME="$PWD/.corepack" pnpm install
```

## Run (dev)
In separate terminals:
```bash
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/server dev
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/web dev
```

Open: `http://localhost:5173`

## Create a session
1. Open the web app (Vite prints the URL, typically `http://localhost:5173`).
2. Enter:
   - Repo path: absolute path to a local repository (must be a directory)
   - Command: any shell command to run in that repo

Example commands:
```bash
node -e "console.log('hello')"
git status
node -e "setInterval(()=>console.log(Date.now()),200)"
claude
codex
```

## Interactive sessions (e.g. Claude)
- Start a session with command `claude` (or `codex` if installed).
- Type directly into the **Terminal (live)** pane (xterm.js). Persisted logs are still available in the Logs tab.

## Budgets (estimated)
- Optional `Budget USD` and/or `Budget tokens` apply to the entire session lifetime.
- The server estimates tokens as `ceil(text.length / 4)` and computes estimated cost using default rates.
- If a budget is exceeded, the session is stopped automatically and `stop_reason` becomes `budget_exceeded`.

## Stop a session
- Select a running session and click **Stop**.
- The server will attempt graceful termination first, then force-kill if needed (best-effort, cross-platform).

## Scripts
- `COREPACK_HOME="$PWD/.corepack" pnpm dev` runs all workspaces in parallel (web + server).
- `COREPACK_HOME="$PWD/.corepack" pnpm build` builds all workspaces.
- `COREPACK_HOME="$PWD/.corepack" pnpm typecheck` runs TypeScript checks across workspaces.

## Tests
```bash
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/server test
```

## Notes
- If you see Corepack cache permission errors, the `COREPACK_HOME="$PWD/.corepack"` prefix keeps Corepack’s cache inside the repo.

## Data location
- SQLite DB: `data/agents_fleet.sqlite` (local only; do not commit).

## Known limitations
- Interactive terminal output is **live-only** in the xterm view; persisted logs are line-based and not a perfect replay of full-screen TUIs.
- PTY sessions do not preserve stdout/stderr separation.
- Token/cost is an estimate unless the CLI provides actual usage.
