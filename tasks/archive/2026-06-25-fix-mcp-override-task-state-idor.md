# Fix MCP override task state IDOR

## Problem

`override_task_state` can write a task scheduler state without proving the task belongs to the caller's project. The Durable Object update is scoped only by `id` and `mission_id`, and does not mirror the `orchestrator_missions` tracking guard used by `cancelMission`.

Impact: a caller scoped to project A could attempt to override a task that belongs to project B, creating a cross-project write risk (CWE-639/863).

## Research Findings

- `apps/api/src/durable-objects/project-orchestrator/index.ts` has `overrideTaskState()` and currently updates D1 with `WHERE id = ? AND mission_id = ?`.
- `cancelMission()` in the same Durable Object first verifies the mission is tracked in `orchestrator_missions`.
- `apps/api/src/routes/mcp/orchestrator-lifecycle-tools.ts` handles `override_task_state` and currently delegates directly to the orchestrator service after parameter validation.
- `apps/api/tests/workers/project-orchestrator-proxy.test.ts` already exercises positive override behavior and same-project cross-mission rejection using real Miniflare Durable Objects.
- Rule 11 requires boundary identity validation and structured rejection logs with relevant IDs.
- Rule 28 requires defence-in-depth tests where a wrong-scope row is returned and code still rejects.
- Rule 02 requires both bug-fix regression tests and tests proving the fixed behavior.

## Implementation Checklist

- [x] Add handler-level task ownership preflight before invoking `overrideTaskState`.
- [x] Log cross-project rejection with caller `projectId`, target `taskId`, target `projectId`, expected/received IDs, and action.
- [x] Add Durable Object guard that mirrors `cancelMission` by verifying the mission is tracked before override.
- [x] Add Durable Object task ownership check before writing state.
- [x] Add `project_id = ?` to the final `UPDATE tasks` predicate.
- [x] Add positive same-project override regression coverage.
- [x] Add cross-project IDOR regression coverage proving project B task state remains unchanged.
- [x] Add handler defence-in-depth unit coverage where a mismatched task row is returned and the handler rejects.
- [x] Run local quality gates for impacted API code.
- [x] Run local specialist review and address findings.

## Validation

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp-orchestrator-lifecycle-tools.test.ts` — passed.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed with existing warnings only.
- `pnpm --filter @simple-agent-manager/api test` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm typecheck` — passed.
- `pnpm lint` — passed with existing warnings only.
- `pnpm build` — passed.
- `pnpm --filter @simple-agent-manager/api test:workers -- tests/workers/project-orchestrator-proxy.test.ts` — blocked by repeated `workerd` segmentation faults in the local Miniflare worker runner.
- `pnpm test` — one unrelated `tests/unit/durable-objects/project-agent.test.ts` timeout in the full root run; the same file passed on targeted rerun.

## Specialist Review

- Security auditor: passed. The MCP handler and Durable Object now perform ownership checks before mutation and avoid cross-project write disclosure by returning a not-found error.
- Cloudflare specialist: passed with environment caveat. D1 access remains parameterized, the final update is project-scoped, and the only blocked Cloudflare gate is the local `workerd` segmentation fault.
- Test engineer: passed with caveat. Unit coverage exercises handler defence-in-depth and positive same-project behavior; the worker vertical-slice regression is present but could not execute locally due `workerd`.
- Constitution validator: passed. No new hardcoded URLs, timeouts, limits, or deployment identifiers were added.
- Task completion validator: passed with caveat. Acceptance criteria map to code/tests; the only incomplete automated evidence is the blocked worker runner.

## Post-Mortem

### What broke

The MCP `override_task_state` tool could attempt a scheduler-state write for a task without first proving that the target task belonged to the caller's project.

### Root cause

`ProjectOrchestrator.overrideTaskState()` updated `tasks` with a predicate scoped only to `(id, mission_id)`, not `project_id`, and it did not mirror the project-local `orchestrator_missions` tracking guard used by `cancelMission()`.

### Timeline

The vulnerable path existed when the mission lifecycle override tool was implemented. It was discovered in security review item MCP-001 on 2026-06-25 and fixed in this task.

### Why it was not caught

Existing tests covered same-project positive behavior and same-project cross-mission rejection, but did not construct a cross-project row or a wrong-scope row returned at the trust boundary.

### Class of bug

Cross-tenant IDOR write caused by relying on partial resource identifiers instead of enforcing project ownership at both the boundary and final write predicate.

### Process fix

Rule 11 now explicitly requires project-scoped writes to preflight target ownership, log mismatches with caller/target project IDs, include `project_id` in final write predicates, and verify Durable Object project-local tracking state before mutating global D1 rows.

## Acceptance Criteria

- The override update predicate includes `project_id`, or equivalently verifies ownership before the write. This task will do both.
- An ownership guard mirrors `cancelMission` before the override applies.
- Cross-project IDOR regression test creates a task in project B, attempts override from project A, asserts rejection, and verifies project B state is unchanged.
- Defence-in-depth handler test returns a mismatched project row and asserts the handler rejects.
- Positive same-project override still succeeds.
- Structured rejection logs include caller projectId, target taskId, and target projectId.

## Constraints

- Do not merge.
- Do not deploy to staging.
- Open a draft PR or leave the branch pushed with `needs-human-review`.
- Stop at PR creation; human handles staging verification and merge.

## References

- Idea: `01KVZGHZACAAYVKF69KVRV5JS2`
- Library doc reference from task: `/security/SAM-security-review-master-local.md`, fileId `01KVZC43FR37A78WZNAMX29Q1S`
- Rules: `.claude/rules/02-quality-gates.md`, `.claude/rules/11-fail-fast-patterns.md`, `.claude/rules/25-review-merge-gate.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`
