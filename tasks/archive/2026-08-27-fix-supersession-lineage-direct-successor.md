# Fix supersession lineage for direct successors of recovery tasks

## Problem

Production task `01M0ZHRRXA3KK6W9AN4ZR5V9FE` was superseded by successor
`01M0ZKNFXC4FKJMDVN006T6WPT` at `2026-08-26T18:00:10.208Z`, but the stuck-task
sweep still wrote `status='failed'` at `2026-08-26T18:06:09.760Z` with
`Task runtime is conclusively gone after reconciliation grace (workspace_deleted).`

The predecessor had already lost its chat/workspace ownership and its workspace row
was `status='deleted'`, but its successor was live and owned the chat session. Per
rule 66, a predecessor with a live successor must be preserved, then eventually
resolved benignly after the successor ends.

## Research findings

- `apps/api/src/services/session-recovery.ts:createRecoveryTask` can create
  successors with different lineage shapes:
  - root-collapsed successor: `recovery_source_task_id = root`
  - direct successor of a recovery middle link when a source task guard is used:
    `recovery_source_task_id = self`
- Before this fix, `apps/api/src/services/task-runtime-liveness.ts:loadTaskSupersession`
  built the family key as `COALESCE(self.recovery_source_task_id, self.id)` and
  matched only:
  - `owner.id = familyKey`
  - `owner.recovery_source_task_id = familyKey`
- That predicate misses a direct successor of a recovery-task middle link, because
  for `self = 01M0ZHRR…`, `familyKey = 01M0ZDXB…`, while the live successor has
  `recovery_source_task_id = 01M0ZHRR…`.
- Production D1 evidence:
  - predecessor `01M0ZHRR…`: `status='failed'`, `triggered_by='session-recovery'`,
    `recovery_source_task_id='01M0ZDXBAZV88E4K3WJVMNVTX4'`,
    `workspace_id='01M0ZHRYAHE52V24MF74V289MW'`, `chat_session_id=NULL`
  - successor `01M0ZKNF…`: `status='in_progress'`, `triggered_by='session-recovery'`,
    `recovery_source_task_id='01M0ZHRRXA3KK6W9AN4ZR5V9FE'`,
    `chat_session_id='90ac3dd3-9fec-432f-8795-bf4e903c239a'`
  - pre-fix `loadTaskSupersession` SQL returned zero rows for the predecessor;
    adding `owner.recovery_source_task_id = self.id` returns the live successor.
- `apps/api/src/scheduled/stuck-tasks.ts` now centralizes terminal writes through
  `terminalReasonFor()` / `transitionTaskToTerminal()`, and the current writer
  honors superseded terminal reasons. The observed failure happened because the
  lineage lookup returned `none`, not because the sweep discarded a computed
  supersession verdict.
- `GET /api/admin/tasks/:taskId/reconciliation-diagnostics` is not useful for this
  already-terminal predecessor because the endpoint only invokes the classifier for
  active `in_progress` rows.

## Implementation checklist

- [x] Add a regression test proving `loadTaskSupersession` returns `live` for a
      recovery-task middle link whose newer successor points directly at the middle
      link.
- [x] Prove the regression fails against pre-fix code.
- [x] Keep existing root-collapsed sibling coverage intact.
- [x] Keep never-superseded task terminalization intact.
- [x] Keep directionality intact: older family members never supersede newer rows.
- [x] Keep bounded escape intact: once the successor is terminal, predecessor resolves
      as benign superseded terminal, not failure.
- [x] Add real-handoff integration coverage proving `createRecoveryTask` can produce
      the direct-child middle-link shape and the classifier protects it.
- [x] Apply the narrow SQL predicate fix in `loadTaskSupersession`.
- [x] Apply the matching write-time fence fix in `transitionTaskToTerminal`.
- [x] Run real-SQL-engine tests for the changed predicate.
- [x] Run full API and repository quality gates required by `/do`.

## Implementation evidence

- Pre-fix targeted suite failed exactly on the direct-child middle-link gap:
  - classifier cases returned `workspace_deleted` instead of
    `workspace_deleted_superseded_by_live_wake` /
    `workspace_deleted_superseded_by_completed_wake`
  - sweep cases wrote `failed` or failed to preserve the predecessor
- Fix: `loadTaskSupersession` and the `transitionTaskToTerminal` write-time
  supersession fence now also match `owner/succ.recovery_source_task_id = self/tasks.id`.
- Post-fix targeted suite:
  - `pnpm --filter @simple-agent-manager/api test tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/stuck-task-superseded-termination.test.ts`
  - Result: 2 files passed, 56 tests passed.
- Post-review real-writer hardening:
  - Added `session-recovery-handoff.test.ts` coverage that first creates a recovery
    middle link through `ensureSessionRecovery`, resets the snapshot claim, then
    invokes `ensureSessionRecovery` with a guard on that middle link. The resulting
    successor has `recovery_source_task_id = middleTaskId`, and the liveness classifier
    preserves the middle link after its workspace is deleted.
  - `pnpm --filter @simple-agent-manager/api test tests/integration/session-recovery-handoff.test.ts tests/unit/stuck-task-slept-session-liveness.test.ts tests/unit/stuck-task-superseded-termination.test.ts`
  - Result: 3 files passed, 66 tests passed.
- Additional post-fix API/Workers coverage:
  - `pnpm --filter @simple-agent-manager/api test tests/unit/services/task-terminal-transition.test.ts tests/unit/stuck-tasks.test.ts`
  - Result: 2 files passed, 63 tests passed.
  - `pnpm --filter @simple-agent-manager/api test:workers tests/workers/scheduled-stuck-tasks.test.ts`
  - Result: 1 file passed, 15 tests passed.
- Repository gates:
  - `pnpm typecheck` passed.
  - `pnpm lint` passed with pre-existing warnings only.
  - `pnpm test` passed: 21/21 turbo tasks successful; API 618 files / 8433 tests passed; web 294 files / 3522 tests passed.
  - `pnpm build` passed: 9/9 turbo tasks successful.

## Acceptance criteria

- A superseded recovery-task predecessor with a live direct successor is preserved.
- A superseded recovery-task predecessor with a terminal direct successor resolves as
  benign cancelled, never failed.
- A never-superseded deleted-workspace task still terminalizes as failed.
- A newer task is not protected by older family members.
- The fix is covered by real SQLite/D1-style tests, not source-contract assertions.

## Remaining `/do` gates

Per `.claude/commands/do.md`, this task file is archived after Phase 4. Specialist
reviews, staging verification, PR merge, and production deploy monitoring remain
tracked in `.do-state.md`, the PR evidence, and final SAM completion evidence.

## References

- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/scheduled/stuck-tasks.ts`
- `apps/api/src/services/session-recovery.ts`
- `tasks/archive/2026-08-24-superseded-task-killed-after-successful-wake.md`
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
