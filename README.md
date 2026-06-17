# Agents Fleet

[![CI](https://github.com/akhilsinghcodes/agents_fleet/actions/workflows/ci.yml/badge.svg)](https://github.com/akhilsinghcodes/agents_fleet/actions/workflows/ci.yml)

AI coding agents like Claude Code and Codex are powerful, but they have no built-in cost controls—one runaway session can silently burn $20–$50 with no visibility into what’s happening or when to stop. Agents Fleet gives you a local web UI to launch and monitor agent sessions and automatically stop them when they hit a token or USD budget.

Local-first “mission control” for AI coding agent CLIs (and any shell commands): launch sessions in a repo, stream live output to a web UI, stop them, and keep a persisted history.

## Visual Overview

![AgentFleet: Stop Runaway AI Agents with Local Mission Control](screenshots/AgentFleet_Local_AI_Mission_Control.png)

## ✨ Recently Shipped
- **AI session summary** (latest)
  - One-click plain-English summary of any session — title, what the agent did, and token/cost breakdown for the summary call
  - Powered by `gpt-4o-mini` via your LiteLLM proxy — under $0.001 per summary
  - Summary persisted in SQLite and surfaced as a top-level artifact alongside git diff
  - Generated session title appears in the sessions sidebar for quick scanning
- **Headroom integration**
  - New **Headroom** tab: LiteLLM chat with transparent context compression via the headroom proxy — same model/budget controls as LiteLLM, compression is automatic
  - ~19% token reduction observed on first real session (948 tokens saved out of 4,901 input)
  - Proxy starts automatically with `pnpm dev:one` — installs `headroom-ai` via pip on first run, polls until ready before starting the app
  - All LLM calls route through `http://localhost:8787/v1` → your `LITELLM_BASE_URL` — no external endpoints called directly
  - Telemetry disabled (`HEADROOM_TELEMETRY=off`), HuggingFace offline after first model download (`HF_HUB_OFFLINE=1`)
  - **Spend Analytics → Headroom tab**: lifetime + per-session compression stats (tokens saved, savings %, cost saved) pulled from the proxy's `/stats` endpoint — persists across restarts via `~/.headroom/proxy_savings.json`
  - Sessions tagged with purple **Headroom** chip in sidebar, distinguished from regular LiteLLM sessions
- **LiteLLM Spend Analytics tab**
  - Real spend data pulled from your LiteLLM proxy (`/spend/logs`, `/user/daily/activity`)
  - Matches Agents Fleet layout: header stats, This Week chart, Weekly Budget strip, By Model and Daily tabs
  - Weekly budget resets Sunday; projects spend and flags over-budget
- **Budget 80% warning notifications**
  - Native browser notification + in-app toast when a session reaches 80% of its USD or token budget
  - Toast auto-dismisses after 8s; works even when browser notifications are blocked
- **One-click session resume** (latest)
  - `claude --resume <uuid>` and `codex resume <uuid>` commands are captured automatically on session exit and shown in the Artifacts tab
  - **Resume** button spawns a new shell session instantly — no copy-paste needed
  - Backfilled across all historical sessions in the database
- **Graceful session exit for Claude and Codex** (latest)
  - Stop button sends Ctrl+C → `/exit` instead of hard-killing, giving Claude/Codex time to save state and print the resume command before exiting
- **Interactive Git Diff Viewer**
  - Side-by-side diff display with line-by-line numbering
  - Paired removed/added lines render adjacent for easy comparison
  - File-level grouping with syntax coloring
- **Spend Analytics Dashboard**
  - View total spend by month, week, or day
  - Drill down by repo, command, or model
  - Real-time cost tracking with USD budgets
- **Budget Tracking in Session Header**
  - Display token budgets (input + output combined) and USD budgets side-by-side with current usage
  - Shows on all tabs: Shell, Claude (SDK), LiteLLM
  - Example: `total 81,772 / 100,000  budget $1.23 / $5.00`
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

**Mission control overview**

![Mission control overview](screenshots/AI_Agent_Mission_Control_Overview.png)

**Local-first architecture**

![Local-first architecture](screenshots/Local_Control_for_AI_Agents.png)

**Create a new session**

- Shell session

![New shell session](screenshots/New_Session_Shell.png)

- Claude (SDK) session

![New Claude SDK session](screenshots/New_Session_Claude_SDK.png)

- LiteLLM session

![New LiteLLM session](screenshots/New_Session_LiteLLM.png)

**Interactive sessions**

- Claude Code / PTY session

![Claude interactive session](screenshots/claude.jpg.png)

- OpenAI Codex / PTY session

![Codex interactive session](screenshots/codex.png)

- Codex scrollback / persisted terminal replay

![Codex scrollable terminal](screenshots/codex_scrollable_terminal.jpg.png)

**Claude SDK chat flow**

- Chat conversation view

![Claude SDK chat](screenshots/claude_sdk_approval_gate.jpg.png)

- Command approval gate

![Claude SDK approval gate](screenshots/claude_sdk_approval_gate.jpg.png)

- Approval accepted

![Claude SDK approval accepted](screenshots/claude_sdk_approval_gate_approved.jpg.png)

- Approval rejected

![Claude SDK approval rejected](screenshots/claude_sdk_approval_gate_rejected.jpg.png)

- Persisted chat history

![Claude SDK history](screenshots/litellm_chat_History.png)

**Per-session artifacts (git diff snapshots + AI summary)**

- Git diff viewer (side-by-side, file tabs)



- Session summary — AI-generated title, description, and token/cost breakdown


- Session summary live — sidebar titles, artifacts tab, and Regenerate button

![Session summary live](screenshots/Session_Summary_Live.png)

**Spend dashboards / budget tracking**

- Default spend dashboard



- Spend dashboard today



- Spend dashboard 7 days



- Spend dashboard by repo



- Spend dashboard by command

![Spend dashboard by command](screenshots/Spend_Dashboard_By_Command.png)

- Spend dashboard by model

![Spend dashboard by model](screenshots/Spend_Dashboard_By_Model.png)

**Session resume**

- Resume artifact in Artifacts tab with Copy + Resume button

![Session resume artifact](screenshots/Session_Resume_Artifact.png)

- Resumed session live terminal

![Session resume terminal](screenshots/Session_Resume_Terminal.png)

**Headroom — context compression**

- Headroom chat tab (proxy connected)


- Headroom chat session in progress

![Headroom chat session](screenshots/Headroom_Chat_Session.png)

- Spend Analytics — session overview (agent usage + savings breakdown)

![Headroom session overview](screenshots/Headroom_Spend_Session_Overview.png)

- Prefix cache impact (cache reads, writes, hit rate)

![Headroom prefix cache impact](screenshots/Headroom_Prefix_Cache_Impact.png)

- Performance stats (token usage + pipeline breakdown)

![Headroom performance stats](screenshots/Headroom_Performance_Stats.png)

- Per-model token savings + recent requests

![Headroom per-model and recent requests](screenshots/Headroom_Per_Model_Recent_Requests.png)

- Request Log tab (per-request detail: model, tokens, latency, cache, status)

![Headroom request log](screenshots/Headroom_Request_Log.png)

- Headroom vs LiteLLM token comparison

![Headroom vs LiteLLM token comparison](screenshots/Headroom_vs_LiteLLM.png)

**LiteLLM Spend Analytics**

- By Model tab — real spend breakdown from proxy

![LiteLLM spend by model](screenshots/LiteLLM_Spend_By_Model.png)

- Daily tab — per-day requests, tokens, and spend

![LiteLLM spend daily](screenshots/LiteLLM_Spend_Daily.png)

**Budget warnings**

- In-app toast (shown when browser notifications are blocked or as a persistent overlay)

![Budget warning toast](screenshots/Budget_Warning_Toast.png)

- Native browser notification

![Budget warning notification](screenshots/Budget_Warning_Notification.png)

- Browser notification permission prompt

![Budget warning permission](screenshots/Budget_Warning_Permission.png)

**SQLite persistence / debug views**

- Sessions table



- Logs table



### Videos

- `screenshots/AgentFleet__AI_Mission_Control.mp4`

The MVP persists several tables in `data/agents_fleet.sqlite`:

- `sessions`: session metadata + budgets + estimated token/cost + stop reason
- `pty_chunks`: raw PTY stream (ANSI included) used for **Terminal (persisted)** replay
- `stdin_events`: input audit trail (stored separately; not injected into replay)
- `session_markers`: lifecycle markers like `stop_requested`, `budget_exceeded`, `process_exit`
- `session_artifacts`: per-session artifacts — git snapshot (`changedFiles[]` + diff captured on stop/exit), session resume command, and AI-generated summary (title + description via gpt-4o-mini)

> Earlier iterations used a line-based `logs` table. The current design persists terminal history as raw PTY chunks (`pty_chunks`) for xterm.js replay, which is much closer to real scrollback (especially for TUIs like Claude/Codex).

### Videos

> Tip: GitHub renders MP4 previews nicely in README. `.mov` files are ignored by default in `.gitignore` to avoid bloating git history.

- `screenshots/AgentFleet__AI_Mission_Control.mp4`

## Architecture
See `ARCHITECTURE.md`.



## Prerequisites
- Node.js 20.x–24.x (Node 26+ not yet supported)
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

**Environment variables:**
- `ANTHROPIC_API_KEY` (required for Claude SDK chat)
- `LITELLM_BASE_URL` and `LITELLM_API_KEY` (optional for LiteLLM Chat via enterprise proxy)
- `HEADROOM_PORT` (optional, default `8787`) — port for the headroom proxy

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

#### (Recommended) Claude Code status line for accurate budget tracking
Claude Code can run a custom status line command that receives structured JSON about the current session (context window usage, estimated cost, etc.).

For the most reliable budget tracking in Agents Fleet, configure a **single-line** status line that prints parse-friendly key/value pairs.

1) Create the script:
```bash
#!/bin/bash
input=$(cat)

CTX_IN=$(echo "$input" | jq -r '.context_window.total_input_tokens // 0')
CTX_OUT=$(echo "$input" | jq -r '.context_window.total_output_tokens // 0')
CTX_SIZE=$(echo "$input" | jq -r '.context_window.context_window_size // 0')
CTX_PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)

COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
COST_FMT=$(printf '$%.6f' "$COST")

# Single-line, parse-friendly output:
# Use a unique prefix + delimiter to make parsing reliable even with TUI redraws.
echo "AF|ctx=${CTX_IN}/${CTX_SIZE}(${CTX_PCT}%)|in=${CTX_IN}|out=${CTX_OUT}|cost=${COST_FMT}"
```
Save it as `~/.claude/agents_fleet_statusline.sh` and make it executable:
```bash
chmod +x ~/.claude/agents_fleet_statusline.sh
```

2) Update `~/.claude/settings.json`:
```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/agents_fleet_statusline.sh",
    "padding": 1,
    "refreshInterval": 1
  }
}
```

Notes:
- Requires `jq` to be installed (`brew install jq` on macOS).
- `cost.total_cost_usd` is an estimate computed client-side by Claude Code and may differ from your actual bill.
- Type directly into the **Terminal (live)** pane (xterm.js).
- Use **Terminal (persisted)** to replay and scroll through the recorded PTY output (xterm.js replay).

#### (Recommended) Codex status line for accurate budget tracking
Codex can also show session usage in a single-line status line. For Agents Fleet, the simplest reliable setup is to keep Codex’s built-in status line enabled and ensure it includes the usage fields below.

1) Update `~/.codex/config.toml`:
```toml
[tui]
status_line = ["model-with-reasoning","current-dir","context-remaining","context-used","total-input-token","total-output-tokens","weekly-limit","five-hour-limit","run-state","task-progress"]
status_line_use_color = true
```

2) Make sure the output stays on one line in the Codex TUI.

Notes:
- The config above matches the usage fields Agents Fleet can parse for budget tracking.
- If you change the field list, keep it single-line so PTY replay remains parse-friendly.
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

![Claude SDK budget stop](screenshots/claude_sdk_approval_gate.jpg.png)

- Claude SDK tool call + output

![Claude SDK tool call](screenshots/claude_sdk_approval_gate.jpg.png)

- Claude SDK tool permission gate (Approve/Reject)

![Claude SDK tool permission](screenshots/claude_sdk_approval_gate_rejected.jpg.png)

### LiteLLM Chat (proxy support)
**Use your enterprise URL and API key to access multiple models through a LiteLLM proxy.**

LiteLLM Chat allows you to:
- Use your enterprise/custom LiteLLM proxy endpoint
- Access models beyond Claude (OpenAI, Anthropic, etc.)
- Route requests through your own infrastructure

**Setup:**
1. Set environment variables:
```bash
export LITELLM_BASE_URL="https://your-litellm-proxy.com"
export LITELLM_API_KEY="your-api-key"
```

2. Switch to **LiteLLM** in the UI.
3. Provide a repo path and select your desired model from the dropdown.
4. Chat and use tools normally—the same Approve/Reject workflow as Claude SDK.

**Notes:**
- `LITELLM_BASE_URL` must be a valid HTTPS URL pointing to your LiteLLM proxy endpoint.
- `LITELLM_API_KEY` is your authentication key for the proxy.
- The available models depend on your LiteLLM proxy configuration.
- Tool output is capped (100KB) and stored as session artifacts, just like Claude SDK.

**Enterprise/Custom LLM Integration:**
If you're running a local or enterprise LiteLLM proxy, Agents Fleet will route all requests through your infrastructure, giving you full control and visibility over API costs and usage.

### Headroom Chat (context compression)
Headroom is a transparent context compression proxy that reduces tokens sent to your LLM by 15–95% depending on context size, with no code changes required.

**Setup:** `pnpm dev:one` handles everything automatically:
- Installs `headroom-ai` via pip if not present (prompts once)
- Downloads the `kompress-base` compression model from HuggingFace (one-time, ~first run)
- Starts the proxy on `http://localhost:8787` before the app
- Routes all Headroom tab calls through the proxy → your `LITELLM_BASE_URL`

**Usage:**
1. Switch to the **Headroom** tab
2. Provide a repo path and select a model — same as LiteLLM
3. Chat normally — compression is transparent
4. View savings in **Spend Analytics → Headroom** tab

**Notes:**
- Requires Python + pip for headroom proxy installation
- Compression kicks in when context exceeds 500 tokens (configurable via `HEADROOM_COMPRESSION_STABLE_AFTER_TURN`)
- Sessions are tagged `[headroom-chat]` and show a purple **Headroom** chip in the sidebar
- Proxy logs: `data/headroom.log`
- Port override: `HEADROOM_PORT=9000 pnpm dev:one`

## Budgets (estimated)
- Optional `Budget USD` and/or `Budget tokens` apply to the entire session lifetime.
- **Token budget:** counts **input + output tokens combined**. When `total_tokens >= budget_tokens`, the session stops.
- **USD budget:** when `estimated_cost >= budget_usd`, the session stops.
- Token estimation: `ceil(text.length / 4)`.
- Cost estimation:
  - shell/PTY sessions use the default rates in `apps/server/src/budget.ts` ($3.00 per 1M input, $15.00 per 1M output by default)
  - Claude SDK sessions use a model-based pricing table (`computeModelCostUsd`) and SDK-reported usage when available.
  - LiteLLM sessions use model-specific pricing from your LiteLLM proxy configuration.
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

## Resource metrics

Agents Fleet ships a `scripts/metrics` script that captures CPU, memory, swap, load, network I/O, disk I/O, open file descriptors, and SQLite DB size — scoped to AgentFleet processes only.

```bash
./scripts/metrics              # one-shot pretty print
./scripts/metrics --watch      # live refresh every 3s
./scripts/metrics --log        # continuous CSV log to data/metrics_<timestamp>.csv (every 5s)
```

To tail the log live while a session runs:
```bash
# Terminal 1
./scripts/metrics --log

# Terminal 2
tail -f data/metrics_<timestamp>.csv
```

**Measured profile (Apple M4 Pro, 24GB RAM):**

| Scenario | CPU% | Memory |
|---|---|---|
| Idle (server + vite only) | 0–1% | ~165MB |
| Claude Shell session active | 1–4% | ~788MB |
| Claude SDK tool calls firing | 3–17% | 600–665MB |
| Git diff capture on stop | 12–47% | spike, clears fast |
| LiteLLM / Spend Analytics | 0–3% | ~165MB |

- Baseline footprint is tiny — 165MB, <1% CPU when no agent is running
- Memory is almost entirely the Claude/Codex process itself, not AgentFleet overhead
- Git diff capture is the heaviest single event (~12% typical, up to 47% if multiple sessions stop together) — lasts <10s and clears cleanly
- No memory leaks observed — memory returns to baseline after every session exits
- Swap usage unchanged throughout — AgentFleet does not add swap pressure
- Data dir grows ~3MB per SDK session — worth monitoring on frequent use

> GPU utilization is not captured without `sudo`. On Apple Silicon (unified memory) run `sudo powermetrics --samplers gpu_power` separately if needed.

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
- **Node version:** Node 20–24 are supported. Node 26+ is blocked by `@homebridge/node-pty-prebuilt-multiarch` (`>=18 <25`). Node 22 and 24 work fine.

## Data location
- SQLite DB: `data/agents_fleet.sqlite` (local only; do not commit).

## Known limitations
- PTY sessions do not preserve stdout/stderr separation.
- Token/cost is an estimate unless the CLI provides actual usage.
- Some TUIs (notably Claude) may clear/restore the alternate screen on exit. The persisted replay is a faithful stream replay, so end-of-session scrollback may differ from what you remember seeing just before exit.
- **No multi-line input in the terminal pane.** The xterm.js terminal forwards keystrokes directly to the PTY; the shell owns the line and executes on Enter. Shift+Enter, Ctrl+Enter, etc. all behave the same as plain Enter — there is no way to insert a newline without submitting at the terminal protocol level. Workarounds inside the shell: end a line with `\` for continuation, or use `$'line1\nline2'` quoting. Inside Claude Code's TUI specifically, `Option+Enter` inserts a newline in the prompt. For free-form multi-line composition, use the Claude (SDK) or LiteLLM chat tabs instead, where Shift+Enter works as expected.