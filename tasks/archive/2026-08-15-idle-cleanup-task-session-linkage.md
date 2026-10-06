# Fix idle cleanup task/session linkage

## Problem

Production idle cleanup repeatedly shows “Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.” and leaves task-mode sessions/workspaces unreaped until coarse backstops. Production verification on 2026-08-15 showed most task-mode `tasks` rows never receive `chat_session_id`, while idle cleanup requires exact `tasks.chat_session_id === reporter.sessionId`.

## Root cause

The major TaskRunner path receives the ProjectData chat session ID and writes it to `workspaces.chat_session_id` plus the ProjectData DO session, but does not write the same linkage to `tasks.chat_session_id`. `terminalizeIdleTaskInD1()` then rejects otherwise valid reporters because the D1 task row appears unlinked. Retry exhaustion deletes the schedule row, emits a user toast, and leaves the session/workspace unreaped.

## Writer/nuller inventory for `tasks.chat_session_id`

- `apps/api/src/durable-objects/task-runner/state-machine.ts` — missing dual-write on the shared TaskRunner session-linking path used by task submit/run, trigger-submit, VM MCP dispatch, SAM-session dispatch, and session-recovery resume.
- `apps/api/src/routes/tasks/submit.ts` — creates a task and ProjectData session, then delegates linkage to TaskRunner. Tracked via TaskRunner dual-write.
- `apps/api/src/routes/tasks/run.ts` — creates a session for an existing ready task, then delegates linkage to TaskRunner. Tracked via TaskRunner dual-write.
- `apps/api/src/services/trigger-submit.ts` — creates a task/session for triggers, then delegates linkage to TaskRunner. Tracked via TaskRunner dual-write.
- `apps/api/src/routes/mcp/dispatch-tool.ts` — creates VM-dispatched tasks/sessions, then delegates linkage to TaskRunner; Instant branch uses `instant-session`. Tracked via TaskRunner dual-write / Instant existing writer.
- `apps/api/src/durable-objects/sam-session/tools/dispatch-task.ts` — creates SAM-session-dispatched tasks/sessions, then delegates linkage to TaskRunner. Tracked via TaskRunner dual-write.
- `apps/api/src/routes/chat.ts` — direct conversation session creation already writes `tasks.chat_session_id`. Existing dual-write.
- `apps/api/src/services/instant-session.ts` — Instant container session creation already writes `tasks.chat_session_id` and `workspaces.chat_session_id`. Existing dual-write.
- `apps/api/src/services/trial/trial-runner.ts` — trial conversation creation already writes `tasks.chat_session_id`. Existing dual-write.
- `apps/api/src/routes/workspaces/crud.ts` — workspace-created conversation task already writes `tasks.chat_session_id` and `workspaces.chat_session_id`. Existing dual-write.
- `apps/api/src/services/session-task-repair.ts` — legacy repair backfills or creates `tasks.chat_session_id`. Repair writer.
- `apps/api/src/services/session-recovery.ts` — intentionally nulls the sleeping session link before creating a replacement recovery task. Must rely on the TaskRunner resume path to re-link the replacement session/workspace/task after the new runtime is created.

## Implementation checklist

- [x] Add TaskRunner D1 task-row linkage write in the same critical step that writes `workspaces.chat_session_id`.
- [x] Ensure session-recovery replacement sessions are re-linked through the TaskRunner resume path.
- [x] Add a safe D1 backfill migration that copies `workspaces.chat_session_id` to exactly one unlinked task for the same project/workspace only when no conflicting task already owns that session.
- [x] Add bounded legacy tolerance in `terminalizeIdleTaskInD1()` for `NULL` task links when the server-written workspace row proves the reporter session binding, and backfill the task row before terminalization.
- [x] Keep non-null different task/session links rejected.
- [x] Make idle cleanup failure/preserved escape paths bounded with env-configurable max residence and a shared `DEFAULT_*` constant.
- [x] Keep retry-exhausted rows visible with durable marker/attention state; do not delete-and-leak silently.
- [x] Emit the user-visible idle cleanup failure system message/toast at most once per session.
- [x] Add regression tests for null-link terminalization, true mismatch, backfill correctness, max-residence zombie prevention, and real SQL WHERE guards.
- [x] Update `.claude/rules/44-dual-write-migration-enumerate-writers.md` for fail-closed identity gates reading linkage columns.
- [x] Record a follow-up SAM idea to calibrate PR #1824’s race-lab oracle against this linkage incident class after #1824 merges (`01M02BZ7K53QRWNDPQZVNDYFQ8`).

## Local validation

- `pnpm --filter @simple-agent-manager/shared build`
- `pnpm --filter @simple-agent-manager/api typecheck`
- `pnpm --filter @simple-agent-manager/api lint`
- `cd apps/api && pnpm vitest run tests/unit/conversation-idle-timeout.test.ts tests/unit/db/task-chat-session-backfill-migration.test.ts tests/unit/durable-objects/task-runner-session-linking.test.ts tests/unit/durable-objects/migrations.test.ts tests/unit/durable-objects/row-schemas.test.ts`
- `pnpm quality:migration-safety`
- `pnpm quality:do-migration-safety`
- `pnpm quality:migration-ordering`
- `pnpm format:check`
- `pnpm lint`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`

## Staging validation

- Staging deploy run `31877133085` completed successfully: Cloudflare deploy job passed and workflow smoke tests passed.
- Staging D1 migration ledger contains `0111_backfill_task_chat_session_id.sql`, applied at `2026-08-15 09:34:48` UTC.
- TaskRunner dual-write verified on staging task `01M02D51E1HKKQ09EKED1YGDG7`: `tasks.chat_session_id = 3f43a32c-b7c0-4c58-8830-12936fd8828e`, matching `workspaces.chat_session_id`, after the task reached workspace `01M02DBZ7ENKVZ0HWMF669784D` on node `01M02D54REQVXKHATKPSNTAQCM`.
- The first task then failed due the staging agent provider limit (`opencode.ai` monthly spending limit) before a NULL-link idle fixture could be created from it.
- A second workspace fixture was created (`workspace 01M02DWSXPZ8X8Q8E3SXN7H5V2`, node `01M02DWSFBDGAVZPZAC12FEWNH`, session `cd93e9fe-0853-4393-a18b-f5864f2302a2`) to avoid the agent-prompt path. The D1 row shape was correct for linkage, but the available staging D1 token rejected any `UPDATE` that would modify existing rows, including the exact guarded `tasks.chat_session_id = NULL` fixture mutation. No unsafe alternate fixture was used.
- Both temporary staging nodes/workspaces were deleted through the product API. Final staging D1 check showed no rows for nodes `01M02D54REQVXKHATKPSNTAQCM` / `01M02DWSFBDGAVZPZAC12FEWNH` or workspaces `01M02DBZ7ENKVZ0HWMF669784D` / `01M02DWSXPZ8X8Q8E3SXN7H5V2`; staging had `0` running nodes afterward.
- Strengthened option-2 fixture: a fresh task-mode Claude Code session (`task 01M02EA4YTKHTH3APA002ZN7RS`, `session 67cc6b58-78ac-4e5f-9396-7405e6e70606`) reached workspace `01M02EHC47BT5RBFPSAFV1V5XF` on node `01M02EA8466HYG25CPJXEEM4VH` and verified the writer fix again: `tasks.chat_session_id` was non-NULL and matched `workspaces.chat_session_id`.
- The same fixture completed at `2026-08-15T10:13:44.750Z`, queued the real session sleep cleanup path, and then failed the staging cleanup proof: `session_snapshots.sleep_status = 'failed'`, `sleep_error = 'Workspace snapshot did not complete within 300000ms'`, `updated_at = '2026-08-15T10:20:20.222Z'`.
- The strengthened fixture node/workspace was deleted through the product API after the failed proof. Final staging D1 check showed no rows for node `01M02EA8466HYG25CPJXEEM4VH` or workspace `01M02EHC47BT5RBFPSAFV1V5XF`; staging had `0` running nodes afterward.

### Second-continuation read-only staging D1 evidence

- Current D1 rows for prior staging fixtures still prove the fixed writer persisted non-NULL task links. The corresponding workspace rows have been deleted as part of required staging cleanup, so current joins cannot re-show the live-time equality without provisioning a new fixture:

| task_id | task_status | task_mode | task_chat_session_id | workspace row |
| --- | --- | --- | --- | --- |
| `01M02D51E1HKKQ09EKED1YGDG7` | `failed` | `task` | `3f43a32c-b7c0-4c58-8830-12936fd8828e` | deleted |
| `01M02EA4YTKHTH3APA002ZN7RS` | `completed` | `task` | `67cc6b58-78ac-4e5f-9396-7405e6e70606` | deleted |
| `01M02GFZZ2AHRB671S1MPRP3YR` | `completed` | `task` | `b2df65e8-f39a-4477-a329-ea68aa2d1c93` | deleted |

- Current staging D1 migration ledger re-read:

```json
[{ "id": 131, "name": "0111_backfill_task_chat_session_id.sql", "applied_at": "2026-08-15 09:34:48" }]
```

- Current staging D1 backfill invariant query re-read:

```json
[{ "remaining_unambiguous_null_task_links": 0 }]
```

- Current staging D1 resource counts re-read after browser smoke:

```json
[
  {
    "non_deleted_nodes": 0,
    "activeish_nodes": 0,
    "non_deleted_workspaces": 0,
    "activeish_workspaces": 0
  }
]
```

### Rule 10 documented staging gaps

- Synthetic NULL-linkage staging fixture not creatable: staging D1 is read-only by design, out-of-band writes and temporary CI-credential workflows were explicitly rejected by parent decision. The NULL-link tolerance branch is covered by discriminating local real-SQL tests plus the staging backfill invariant above.
- Conclusively-dead-runtime staging fixture not achievable read-only: forcing a real dead runtime would require mutating runtime/node state outside normal product paths. Terminalization-on-dead-runtime is covered by the local real-SQL/Miniflare tests, including the pre-fix-red NULL-linkage sweep case, different-session rejection control, and bounded escape-path cases.

### Snapshot carve-out

- Parent decision for the second continuation carves out the completed→sleep→snapshot leg from this PR. The failing path is a pre-existing production/staging snapshot bug owned by SAM task `01M02HNZPJ82CQGV07DG2BGFGQ`, not by this linkage branch.
- Fresh production D1 aggregate on 2026-08-15 showed current `session_snapshots.sleep_status = 'failed'` rows with `sleep_error = 'Workspace snapshot did not complete within 300000ms'` at `2026-08-15T09:16:37Z` and `2026-08-15T09:56:38Z`, plus degraded/retry-budget snapshot failures around 2026-08-14/15 (`home-skipped` retry budget exhausted and `transcript-only` incomplete snapshot). The timeout is thrown from `apps/api/src/services/session-sleep.ts:179`.
- The branch diff does not touch `apps/api/src/services/session-sleep.ts` or `apps/api/src/services/session-snapshot-*`, and does not touch the PR #1824 coordination files.

## Specialist review evidence

| Reviewer | Status | Outcome |
|---|---|---|
| env-validator | PASS | `IDLE_CLEANUP_MAX_RESIDENCE_MS` is declared in Env and ProjectData Env, documented in `.env.example`, public configuration docs, and env-reference; no GH/GITHUB secret mapping applies. |
| constitution-validator | PASS | Idle cleanup max residence uses shared `DEFAULT_IDLE_CLEANUP_MAX_RESIDENCE_MS` plus env override; no new hardcoded URLs or unconfigurable production identifiers. |
| test-engineer | PASS | Regression coverage includes NULL-link task-mode terminalization/reap, true mismatch rejection, real-SQL backfill guards, max-residence zombie exit, retry toast de-duplication, and TaskRunner dual-write/fail-closed behavior. |
| cloudflare-specialist | PASS | D1 migration is guarded/additive, DO migration only adds columns/indexes, migration safety checks pass, and no PR #1824 race-lab files were touched. |
| doc-sync-validator | PASS | Environment docs and rule 44 were updated; task file includes writer/nuller inventory, post-mortem, and process fix. |
| task-completion-validator | PASS | Planned-vs-actual validation found each research finding/checklist item represented in the diff, each acceptance criterion covered by local tests or documented Rule 10 staging gaps, no UI-to-backend propagation path in scope, and no multi-resource selector risk. |

## Task completion validation report

**Task**: `tasks/archive/2026-08-15-idle-cleanup-task-session-linkage.md`  
**Branch**: `sam/fix-production-idle-cleanup-qs8r55`  
**Date**: 2026-08-15

### Verdict: PASS

| Check | Status | Issues |
| --- | --- | --- |
| A: Research → Checklist | PASS | Root-cause findings map to TaskRunner dual-write, legacy NULL-link terminalization tolerance/backfill, bounded escape paths, retry notification durability, Rule 44 update, and follow-up idea. |
| B: Checklist → Diff | PASS | Checked items are represented in the diff across TaskRunner, idle cleanup terminalization, D1 migration, DO migration, env/shared constants, docs/rule 44, and tests. |
| C: Criteria → Tests | PASS | Acceptance criteria are covered by local real-SQL/Miniflare tests plus documented staging evidence/gaps for read-only-only fixtures. |
| D: UI → Backend | N/A | No `apps/web/**` UI diff or new input propagation path. |
| E: Multi-Resource | N/A | No provider/resource selector logic or `.limit(1)` selection path introduced. |
| F: Vertical Slice | PASS | The branch crosses D1/DO/scheduler paths and includes real-SQL migration/terminalization tests, TaskRunner D1 writer tests, DO schema tests, and full local validation. |

### Uncovered research findings

| Finding | Task file line | Checklist item? | In diff? | Status |
| --- | --- | --- | --- | --- |
| TaskRunner writes workspace/session linkage but not `tasks.chat_session_id` | 9, 13 | Yes | Yes: `state-machine.ts` guarded task update and fail-closed reread | OK |
| Idle cleanup rejects valid NULL-linked task rows | 9 | Yes | Yes: `idle-cleanup-terminalization.ts` workspace-bound NULL-link tolerance and guarded backfill | OK |
| Retry exhaustion deletes schedule row and leaks durable visibility | 9 | Yes | Yes: `idle-cleanup.ts` terminal attention state and no delete-on-exhaustion | OK |
| Backfill required only for unambiguous workspace-derived links | 30 | Yes | Yes: migration `0111_backfill_task_chat_session_id.sql` and migration test | OK |
| Session recovery nulling path must re-link replacement session | 24, 29 | Yes | Yes: TaskRunner shared resume/link path now writes task/workspace/session identity | OK |
| Rule/process gap for identity gates reading linkage columns | 37, 133-139 | Yes | Yes: `.claude/rules/44-dual-write-migration-enumerate-writers.md` update | OK |

### Uncovered acceptance criteria

| Criterion | Test / verification | Manual verification | Status |
| --- | --- | --- | --- |
| NULL-linked task with matching workspace binding terminalizes and cleans up | `conversation-idle-timeout.test.ts` NULL-link terminalization/reap cases | Rule 10 staging gap documented because staging D1 is read-only | COVERED |
| Different non-null task/session link is rejected | `conversation-idle-timeout.test.ts`, `task-runner-session-linking.test.ts` | N/A | COVERED |
| Migration backfills only unambiguous workspace-derived links | `task-chat-session-backfill-migration.test.ts`; staging invariant `remaining_unambiguous_null_task_links = 0` | Migration ledger row id `131` applied at `2026-08-15 09:34:48` | COVERED |
| Preserved candidates leave active set after bounded max residence | `conversation-idle-timeout.test.ts` max-residence zombie prevention | N/A | COVERED |
| Retry exhaustion keeps durable record and does not spam repeated toasts | `conversation-idle-timeout.test.ts` retry-toast de-duplication | Staging baseline requires zero new branch-caused idle-cleanup failed toasts | COVERED |
| Newly started task-mode sessions write `tasks.chat_session_id` | `task-runner-session-linking.test.ts`; staging fixture rows persisted non-NULL task links | Current staging D1 re-read of tasks `01M02D51E1HKKQ09EKED1YGDG7`, `01M02EA4YTKHTH3APA002ZN7RS`, `01M02GFZZ2AHRB671S1MPRP3YR` | COVERED |

### UI-to-backend data path audit

| UI Element | State Variable | In API Call? | In Request Type? | Backend Reads It? | Status |
| --- | --- | --- | --- | --- | --- |
| N/A | N/A | N/A | N/A | N/A | OK |

### Recommendations

1. No additional implementation work required before archival.
2. Preserve the two Rule 10 staging gaps and snapshot carve-out in the PR body so CI/preflight reviewers do not treat the unrelated snapshot failure as this branch’s blocker.

## Acceptance criteria

- A task-mode session whose task row has `chat_session_id IS NULL` but whose workspace row has the reporter session ID is terminalized and cleaned up by idle cleanup.
- A task linked to a different non-null session is rejected and left untouched.
- The migration backfills only unambiguous workspace-derived links and leaves ambiguous/absent workspace linkage untouched.
- Permanently preserved idle cleanup candidates leave the active candidate set after a bounded max residence.
- Retry exhaustion does not delete the only durable cleanup record and does not spam repeated toasts.
- Staging verifies newly started task-mode sessions write `tasks.chat_session_id`; NULL-linkage and terminalization-on-dead-runtime staging fixtures are documented Rule 10 gaps and covered by discriminating local real-SQL/Miniflare tests.

## Post-mortem

- What broke: idle cleanup fail-closed task/session identity checks rejected valid task-mode sessions because the D1 task linkage column was blank.
- Timeline: `tasks.chat_session_id` was added as a nullable compatibility link, but the dominant TaskRunner session path never wrote it. Production evidence on 2026-08-15 showed only a minority of daily tasks had linkage and only one historical idle-cleanup terminalization event.
- Why it was not caught: tests validated `workspaces.chat_session_id` and TaskRunner config pass-through, but not the downstream identity gate that consumes `tasks.chat_session_id`. Existing unit tests used fully linked fixtures, so the missing writer never mattered.
- Class of bug: a fail-closed identity gate reading a linkage column that a major writer never populates.
- Process fix: extend rule 44 so identity-gate PRs must enumerate every writer/nuller of the linkage columns they read, not only explicit storage migrations.

## References

- `apps/api/src/durable-objects/project-data/idle-cleanup.ts`
- `apps/api/src/durable-objects/project-data/idle-cleanup-terminalization.ts`
- `apps/api/src/durable-objects/task-runner/state-machine.ts`
- `apps/api/src/services/session-recovery.ts`
- `apps/api/src/services/session-task-repair.ts`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
