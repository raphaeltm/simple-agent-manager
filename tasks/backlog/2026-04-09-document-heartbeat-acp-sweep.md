# Document HEARTBEAT_ACP_SWEEP_TIMEOUT_MS and Node Heartbeat ACP Piggybacking

> **Reconciliation 2026-09-30:** still open. `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` is still missing
> from `apps/api/.env.example` and the docs configuration reference. Corrections: the default
> is now 15000 ms, not 8000 (`apps/api/src/routes/node-lifecycle.ts:512`), and the sweep is only
> a backup to the direct VM-agent ACP heartbeat (`:510–511`). Drop the CLAUDE.md "Recent
> Changes" item; that section no longer exists.

## Problem

PR #647 introduced `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` env var and the node heartbeat ACP session piggybacking pattern. Neither was documented in CLAUDE.md's Recent Changes section or `apps/api/.env.example`.

## Acceptance Criteria

- [ ] Add `HEARTBEAT_ACP_SWEEP_TIMEOUT_MS` (default: 8000) to `apps/api/.env.example` with description
- [ ] Add unified-agent-workspace-lifecycle entry to CLAUDE.md Recent Changes
- [ ] Mention the node heartbeat piggybacking pattern (ACP sessions updated via node heartbeats, not per-session goroutines)

## Key Files

- `CLAUDE.md` — Recent Changes section
- `apps/api/.env.example` — env var reference
- `apps/api/src/routes/nodes.ts` — implementation location

## Context

Found by task-completion-validator reviewing PR #647.
