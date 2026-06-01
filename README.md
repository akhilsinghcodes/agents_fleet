# Agents Fleet (prototype)

[![CI](https://github.com/akhilsinghcodes/agents_fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/akhilsinghcodes/agents_fleet/actions/workflows/ci.yml)

AI coding agents like Claude Code and Codex are powerful, but they have no built-in cost controls—one runaway session can silently burn $20–$50 with no visibility into what’s happening or when to stop. Agents Fleet gives you a local web UI to launch and monitor agent sessions and automatically stop them when they hit a token or USD budget.

Local-first “mission control” for AI coding agent CLIs (and any shell commands): launch sessions in a repo, stream live output to a web UI, stop them, and keep a persisted history.

This repository contains a **working MVP**:
- pnpm workspace monorepo
- React + Vite + TypeScript “Mission Control” web app
- Node + Express + TypeScript server:
  - SQLite persistence (`data/agents_fleet.sqlite`)
  - session + terminal history HTTP APIs
  - WebSocket streaming (`/ws`):
    - live PTY output for shell/CLI sessions
    - live Claude SDK chat streaming + tool events
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

**Per-session artifacts (git diff snapshots)**

- Artifacts tab (changed files + diff)

![Artifacts view](screenshots/artifacts_git_snapshot_small.jpg)

- Artifacts view (larger change set)

![Artifacts view (large change)](screenshots/artifacts_git_snapshot_large.jpg)

**Live output vs persisted terminal history**

- Terminal (live)

![git status live](screenshots/git_status_live.png)

- Terminal (persisted)

![git status persisted logs](screenshots/git_status_logs.png)

**Budget enforcement (auto-stop)**

- Token budget cutoff

![Token budget cutoff](screenshots/cutoff_based_on_tokens.png)

- USD budget cutoff

![USD budget cutoff](screenshots/cutoff_based_on_cost.png)

**Cost estimate vs actual (CLI-reported)**

![Claude actual cost vs estimate](screenshots/claude_Actual_cost_vs_estimate.png)

**SQLite persistence (debug views)**

![sessions table](screenshots/session_table.png)

The MVP persists several tables in `data/agents_fleet.sqlite`:

- `sessions`: session metadata + budgets + estimated token/cost + stop reason
- `pty_chunks`: raw PTY stream (ANSI included) used for **Terminal (persisted)** replay
- `stdin_events`: input audit trail (stored separately; not injected into replay)
- `session_markers`: lifecycle markers like `stop_requested`, `budget_exceeded`, `process_exit`
- `session_artifacts`: per-session artifacts (currently: git snapshot with `changedFiles[]` + combined staged/unstaged `diff` captured on stop/exit)

> Earlier iterations used a line-based `logs` table. The current design persists terminal history as raw PTY chunks (`pty_chunks`) for xterm.js replay, which is much closer to real scrollback (especially for TUIs like Claude/Codex).

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

## Run (dev) — one command
```bash
pnpm dev:one
```

On first run, this may optionally prompt you for `ANTHROPIC_API_KEY` and save it to `.env.local` (gitignored). Press Enter to skip.

This will:
- install dependencies (if needed)
- start `apps/server` + `apps/web` in parallel

Open: `http://localhost:5173`

## Run (dev) — manual (two terminals)
```bash
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/server dev
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/web dev
```

## Create a session
1. Open the web app (Vite prints the URL, typically `http://localhost:5173`).
2. Enter:
   - Repo path: absolute path to a local repository (must be a directory)
   - Command: any shell command to run in that repo

Example commands:
```bash
node -e "console.log('hello')"
git status
node -e "setinterval(()=>console.log('tick',Date.now()),200)"
node -e "setInterval(()=>console.log(Date.now()),200)"
claude
codex
```

## Interactive sessions (e.g. Claude)
### Claude Code / Codex (PTY)
- Start a session with command `claude` (or `codex` if installed).
- Type directly into the **Terminal (live)** pane (xterm.js).
- Use **Terminal (persisted)** to replay and scroll through the recorded PTY output (xterm.js replay).

### Claude (SDK) chat (tool-calling)
**Prerequisite:** set `ANTHROPIC_API_KEY` (required). The server will reject Claude SDK requests if it’s missing.

- Switch to **Claude (SDK)** in the UI.
- Provide a repo path and chat normally.
- The assistant can propose `run_command` tool calls; you must **Approve** or **Reject** each command.
- Tool output is capped (100KB) and stored as session artifacts.

Screenshots:
- Claude SDK session stopped by budget

![Claude SDK budget stop](screenshots/claude_chat_budget.jpg)

- Claude SDK tool call + output

![Claude SDK tool call](screenshots/claude_chat_tool_call.jpg)

- Claude SDK tool permission gate (Approve/Reject)

![Claude SDK tool permission](screenshots/claude_chat_tool_permission.jpg)

## Budgets (estimated)
- Optional `Budget USD` and/or `Budget tokens` apply to the entire session lifetime.
- Token estimation: `ceil(text.length / 4)`.
- Cost estimation:
  - shell/PTY sessions use the default rates in `apps/server/src/budget.ts`
  - Claude SDK sessions use a model-based pricing table (`computeModelCostUsd`) and SDK-reported usage when available.
- If a budget is exceeded, the session is stopped automatically and `stop_reason` becomes `budget_exceeded`.

> Note: USD cost is still an estimate unless you configure model pricing to match your account/contract.
>
> Configure pricing via a remote API (`PRICING_API_URL`, must be https) or via local overrides (`PRICING_JSON` inline JSON / `PRICING_JSON_PATH` file path). See `apps/server/src/pricing.ts` for schema + env vars.

## Stop a session
- Select a running session and click **Stop**.
- The server will attempt graceful termination first, then force-kill if needed (best-effort, cross-platform).

## Per-session artifacts (git diff snapshots)
On session **stop** and/or **exit**, Agents Fleet can capture a git snapshot for the session repo and store it in SQLite.

- UI: open the **Artifacts** tab (next to Terminal tabs) to view changed files + diff.
- Storage: `session_artifacts` table.
- Toggle: set `AGENTS_FLEET_CAPTURE_GIT_ON_END=0` to disable capture.

## Scripts
- `pnpm dev:one` installs deps if needed and runs dev for all workspaces (web + server).
- `pnpm dev` runs dev for all workspaces (web + server) in parallel.
- `pnpm check` runs `lint` + `typecheck` + `test` + `build`.
- `pnpm build` builds all workspaces.
- `pnpm typecheck` runs TypeScript checks across workspaces.

## Tests
```bash
COREPACK_HOME="$PWD/.corepack" pnpm -C apps/server test
```

## Notes
- If you see Corepack cache permission errors, the `COREPACK_HOME="$PWD/.corepack"` prefix keeps Corepack’s cache inside the repo.

## Data location
- SQLite DB: `data/agents_fleet.sqlite` (local only; do not commit).

## Known limitations
- PTY sessions do not preserve stdout/stderr separation.
- Token/cost is an estimate unless the CLI provides actual usage.
- Some TUIs (notably Claude) may clear/restore the alternate screen on exit. The persisted replay is a faithful stream replay, so end-of-session scrollback may differ from what you remember seeing just before exit.
