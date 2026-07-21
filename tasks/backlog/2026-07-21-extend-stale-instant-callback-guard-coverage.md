# Extend Stale Instant-Callback Guard to Non-Destructive Regressions

## Problem

PR (branch `sam/diagnose-fix-remaining-production-0dvhf5`) added a freshness guard (`apps/api/src/routes/_stale-callback-guard.ts`) that rejects destructive `error`/`failed` callbacks arriving from a superseded Instant container generation after a completed recovery. Two adjacent surfaces remain unguarded:

1. **Stale `completed`/`cancelled` task callbacks** (`apps/api/src/routes/tasks/callback.ts`): a late terminal-success callback from a dead container generation could prematurely complete/cancel a task the recovered generation is still working on.
2. **Stale `idle` activity callbacks** (`apps/api/src/routes/projects/agent-activity-callback.ts`): a late `idle` report from the dead generation could mark the live recovered session idle and trigger an early hibernate/handback on the healthy runtime.

Both are less damaging than the guarded `error`/`failed` regressions (work is preserved; the session can wake again), which is why they were scoped out of the recovery PR.

Known residual gaps of the existing guard (documented in the PR): supersession within the freshness margin (default 60s, tunable via `INSTANT_STALE_CALLBACK_MARGIN_MS`), and callbacks landing after container death but before `persistRuntimeRecovering` stamps the row.

## Context

Identified by the security-auditor review of the Instant runtime recovery work (2026-07-21) and scoped out by the implementing agent as follow-up. A durable fix for the whole class would be a generation/epoch claim minted into callback tokens by the `VmAgentContainer` DO on every `launch()`/`wakeFromSnapshot()` and persisted for comparison — that design needs DO + token changes the recovery PR intentionally avoided.

## Acceptance Criteria

- [ ] Decide guard-vs-epoch: either extend the freshness guard to `completed`/`cancelled`/`idle` transitions, or implement the generation/epoch token claim and retire the freshness heuristic.
- [ ] A stale `idle` from a superseded generation cannot hibernate a live recovered session (behavioral test).
- [ ] A stale `completed`/`cancelled` from a superseded generation cannot terminate a task the recovered generation is progressing (behavioral test).
- [ ] Legitimate current-generation reports still flow (negative tests).
- [ ] Rejections log structured warns per `.claude/rules/11` and return statuses the vm-agent clients tolerate without retry storms.
