# Agents Fleet Roadmap

## Now (MVP hardening)
- Add CI to run `pnpm -r typecheck` and `pnpm -C apps/server test`.
- Improve terminal fit/focus reliability across reloads/session switches.
- Harden crash recovery: detect orphaned running sessions and mark them ended on server start.
- Better error surfaces in UI (spawn failures, invalid repo paths, budget stops).

## Next (Agent mission control)
- Capture git diff + changed files per session (optional on stop / on exit).
- Model-based cost profiles and parsing “actual usage” when CLIs expose it.
- Per-session artifacts (patches, logs export, replay bundle) and one-click export.

## Later
- Approvals / policy gates for risky commands (local-only).
- Team/shared workspaces (still local-first, optional sync later).
- Optional local proxy mode for exact budget enforcement and richer telemetry.

