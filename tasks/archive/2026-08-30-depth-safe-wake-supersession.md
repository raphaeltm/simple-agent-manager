# Fix depth-safe wake supersession

## Problem

Guarded `parent_wakeup` recovery tasks can form depth-2+ supersession chains. The current liveness and guard code only reasons about one hop or about a terminal/non-terminal predecessor status, so an intermediate predecessor can be falsely failed and then revoke the successor's recovery authority.

## Research findings

- `apps/api/src/services/session-recovery.ts` creates wake successors and records `superseded_by_task_id` on the predecessor during handoff.
- `apps/api/src/services/task-runtime-liveness.ts` owns the shared supersession probe used before terminal task verdicts.
- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts` owns SQL predicates and validation helpers for source-task guards.
- `apps/api/src/scheduled/stuck-tasks.ts` has a separate absolute-cost ceiling path whose supersession lookup currently fails open.
- Prior rule context:
  - Rule 66: ownership handoff must record exact supersession.
  - Rule 58: terminal verdicts must match the resumer and lookup failures must withhold destructive verdicts.
  - Rule 47: extra reads must stay bounded and off the hot path.
  - Rule 28: SQL predicate guards need real SQL engine tests.
  - Rule 61: runtime guards must cover all runtimes.

## Implementation checklist

- [x] Inspect current implementation and tests for supersession, recovery guards, and stuck sweep ceiling.
- [x] Update `loadTaskSupersession` to traverse `superseded_by_task_id` chains to the current exact owner with bounded reads.
- [x] Update guard predicates/helpers so a cancelled superseded source remains valid/wakeable when its marker points to a live successor.
- [x] Change stuck-task ceiling handling so supersession lookup errors become `unknown` and terminalization is withheld.
- [x] Retire predecessors as `cancelled` based on exact successor takeover status.
- [x] Add/adjust regression tests covering depth-2 and depth-3 chains, dead controls, manual/automatic wake semantics, ceiling unknown, and marker-aware real-SQL guards.
- [x] Run relevant API tests plus full quality gates.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- --run tests/unit/stuck-tasks.test.ts tests/unit/services/task-terminal-transition.test.ts tests/unit/durable-objects/durable-prompt-delivery.test.ts tests/integration/session-recovery-handoff.test.ts tests/unit/stuck-task-superseded-termination.test.ts tests/unit/stuck-task-slept-session-liveness.test.ts`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Review

- Cloudflare/DO: recursive supersession traversal is bounded and only runs for tasks already near terminalization.
- Constitution: no new credentials, URLs, environment-specific constants, or deployment assumptions.
- Test completion: required depth, guard, ceiling-error, manual/automatic, and genuine-death controls are covered.

## Acceptance criteria

- Depth-2+ guarded wake chains resolve to the current owner rather than failing intermediates.
- Guarded wake authority is not revoked only because a predecessor was benignly cancelled after supersession.
- Failed supersession probes at the ceiling withhold terminal verdicts instead of failing a task.
- Genuine never-superseded dead runtimes are still failed by the sweep.
- SQL guard predicates are verified against the real SQL test engine with discriminating controls.

## References

- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/services/session-recovery.ts`
- `apps/api/src/services/session-snapshot-recovery-lifecycle.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/durable-objects/project-data/prompt-delivery-runner.ts`
- `apps/api/src/routes/mcp/task-wait-supervisor.ts`
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/47-control-loop-io-budget.md`
