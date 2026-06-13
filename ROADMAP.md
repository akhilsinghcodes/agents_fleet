# Agents Fleet Roadmap

## Done
- Budget 80% warning: native browser notification + in-app toast when a session hits 80% of its USD or token budget.
- One-click session resume: Resume button in Artifacts tab spawns a new shell session instantly. `claude --resume` / `codex resume` captured on graceful exit, backfilled across all historical sessions.
- Graceful exit for Claude and Codex: Stop button sends Ctrl+C → `/exit` before force-killing, so state is saved and the resume command is printed.
- Crash recovery: sessions stuck in `running` on server start are automatically marked `stopped` with `stop_reason: crash_recovery`.
- LiteLLM Spend Analytics: dedicated tab in Spend Analytics pulling real cost data from LiteLLM proxy — header stats, This Week chart, Weekly Budget strip (Sunday reset), By Model and Daily breakdown tabs.

## Next (Agent mission control)
1. **Multiple sessions management** — Batch-stop, group by repo, launch parallel sessions from the UI. Core to the "fleet" value prop.
2. **Per-session artifacts UX** — View/export bundle (diff, changed files list, PTY replay export).
3. **Budget accuracy hardening** — Model-specific pricing and SDK-reported usage everywhere; add tests.
4. **System resource monitoring** — CPU, memory, and GPU usage live in the UI via `systeminformation`. Per-session PID tracking to show exactly what each agent consumes.

## Later
- Paste/attachments in Claude (SDK) and LiteLLM chat (images, files via Anthropic Files API).
- UI polish pass: budget progress animations, spinners, improved session status indicators.
- Exact token/cost via a local tokenizer (e.g. WASM tiktoken) for closer budget enforcement.
- Team/shared workspaces (still local-first, optional sync later).
- Optional local proxy mode for exact budget enforcement and richer telemetry.
