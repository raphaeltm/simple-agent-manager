# Durable Admin Diagnosis Runner

## Problem

PR #1722 added durable run identity/status, but the multi-turn diagnosis still executes inside HTTP `ctx.waitUntil`. Production run `01KZ5WDZ4Y22KXKTMEWAN04VTM` completed one model turn, then execution disappeared and left a permanently stale `running` row. At investigation time production had no completed `debug_diagnoses`.

Admin diagnostics need a durable execution owner, inspectable safe events, recoverable controls, and a dedicated detail UI. Browser lifetime must have no effect after the start request returns `202`.

## Research Findings

- `apps/api/src/routes/admin.ts` currently creates a D1 row then registers `executeDebugDiagnosisRun()` with `ctx.waitUntil`; cancellation may prevent the catch path from writing a terminal status.
- `apps/api/src/services/debug-agent.ts` holds the whole model/tool loop in memory and only persists a diagnosis after the final model answer. Tool failures collapse to a generic unavailable message.
- `apps/api/src/durable-objects/task-runner/index.ts` provides the repository pattern for one-entity-per-DO alarm state machines, idempotent `start`, `ensureStarted`, checkpointing, and bounded backoff.
- D1 `debug_diagnosis_runs` is the existing query/history surface and must remain the system of record. A new append-only events table can expose observable actions without model reasoning.
- `apps/web/src/components/admin/ErrorList.tsx` loads history once, keeps launches in component state, and incorrectly claims active runs are “Recoverable after refresh.” There is no deep-linkable detail route.
- Admin routes are protected by auth, approval, and superadmin middleware. The new detail/events/retry/cancel surfaces must remain behind the same boundary.
- `.claude/rules/43-long-running-mcp-tools.md` forbids request-owned long-running execution; `.claude/rules/17-ui-visual-testing.md` requires mobile/desktop screenshot-backed audits for the new page.
- The separate VM incident-evidence idea remains out of scope; events expose a clean source/evidence contract for later collectors.

## Implementation Checklist

- [x] Add D1 run/event fields, indexes, migration, shared safe event/detail/cursor contracts, configurable runner limits, and the `DIAGNOSIS_RUNNER` binding/migration/export.
- [x] Implement one `DiagnosisRunner` DO per run with transactional initial alarm, one model turn or tool call per alarm, idempotent step keys, D1 checkpoints/events before the next alarm, token accounting, classified bounded retry/backoff, hard deadline, cancellation, and sanitized failures.
- [x] Replace route `waitUntil` ownership with an idempotent DO start/ensure-started handshake and preserve retry lineage with new run IDs.
- [x] Add a scheduled reconciler that re-kicks queued/stale-running runs and terminalizes anything past its deadline.
- [x] Add strictly superadmin-authorized detail, event cursor, retry, and cancel APIs.
- [x] Add `/admin/diagnoses/:runId`, recoverable polling, current step/timeline/systems/result/failure/actions, launch/retry navigation, and linked recent runs on `/admin/errors`.
- [x] Add deterministic fake model/tool and fault-injection tests for browser closure, restarts, duplicate start/alarm, retry classes, deadline reconciliation, cancellation, redaction/XSS, authorization, and cursor behavior.
- [x] Add mobile/desktop Playwright behavior and visual audits with normal, long, empty, many-event, active, completed, and failure states.
- [x] Add operational metrics/logging and document the durable runner/event integration point where appropriate.
- [x] Complete quality suite, mandatory task-completion validation, and all requested specialist reviews; reconcile every critical/high finding.
- [ ] Deploy and verify on staging, create PR, achieve green CI, merge, monitor production deployment, and run a bounded production smoke proving a completed diagnosis with populated events.

## Acceptance Criteria

- Closing the browser after `202` cannot stop execution.
- Every alarm performs at most one model turn or one tool call and persists output, usage, heartbeat, current step, and a safe event before scheduling another alarm.
- Duplicate starts/alarms and transition restarts do not duplicate completed steps or tool side effects.
- Classified transient failures retry with bounded configurable backoff; permanent failures terminalize immediately.
- No queued/running row remains nonterminal beyond its configured hard deadline.
- Cancellation and retry are idempotent; retry creates a new run with lineage.
- Direct-link/refresh recovers current state and complete event history; event polling uses a monotonic cursor.
- Events expose systems/actions, bounded redacted arguments/evidence, counts/durations, and sanitized failures, never hidden chain-of-thought.
- All diagnosis surfaces remain approved-superadmin-only and no machine-generated diagnostic output is posted to public GitHub issues.
- Mobile and desktop UI clearly expose active, complete, failed, unavailable-source, cancel, retry, and copy states with no horizontal overflow or XSS rendering.
- A fault-injected restart completes or visibly fails; production smoke creates a completed diagnosis and populated event timeline.

## References

- Canonical idea `01KZ1WR6160C3W6VW165914ZW0`
- Production run `01KZ5WDZ4Y22KXKTMEWAN04VTM`
- PR #1722
- `apps/api/src/routes/admin.ts`
- `apps/api/src/services/debug-agent.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/durable-objects/task-runner/index.ts`
- `apps/web/src/components/admin/ErrorList.tsx`
- `apps/web/src/components/admin/DebugDiagnosisPanel.tsx`
- `.claude/rules/43-long-running-mcp-tools.md`
