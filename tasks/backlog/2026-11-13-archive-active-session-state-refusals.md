# Archive: attribute the remaining `active_session_state` pre-copy refusals

## Problem

After #2700 dropped `activity = 'error'` from the archive eligibility check, production still refused
24 candidates as `active_session_state` in the first ~1.5 h after deploy (2026-11-13 00:20-01:55Z,
read-only D1). These sessions are stopped/failed and past the 7-day grace, so a `prompting` /
`recovering` activity or an `active` / `settling` `runtime_work_state` row is likely stale.

## Context

`assertEligibleTerminalSource` (`apps/api/src/durable-objects/project-data/archive-sharding.ts`).
Found during the archive drain redesign (task `tasks/active/2026-11-12-projectdata-archive-drain.md`).

## Acceptance Criteria

- [ ] Read-only DO-side attribution of which session_state values block these sessions.
- [ ] If stale: terminal paths clear them, or the eligibility check ignores state older than the
      session's terminal time; real-path test with a stale row and a live-work control.
