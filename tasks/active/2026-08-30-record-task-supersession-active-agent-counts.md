# Record task supersession and fix active-agent counts

SAM task: `01M18TKNYG273EW4GM94NADFHG`  
Output branch: `sam/record-task-supersession-explicitly-nadfhg`

## Problem

Production audit `01M18N606BD1VFHPT40W04ZVNT` found SAM's "active agents" counts are inflated by superseded sleep/wake predecessor tasks: 68 `in_progress` tasks vs 4 running workspaces, with 53 of the 68 being chat-unbound session-recovery predecessors. `createRecoveryTask()` hands a conversation to a successor, clears the predecessor's `tasks.chat_session_id`, and records no replacement marker on the predecessor row. The liveness classifier now preserves those predecessors while any live family member exists; for open conversation-mode sessions this can last indefinitely.

This task must add an explicit supersession marker and make all active-agent counting/listing surfaces derive state through one shared service instead of counting by task status alone.

## Required context

- SAM idea `01M0SG7ZEE1XARK4QDG7V6HDPN`:
  - PR #1896 closed the immediate false-failure path by making supersession liveness direct-child/root-family-aware.
  - The 2026-08-30 update shows preserved predecessors are now the inflated active-agent population.
  - Recommended durable model starts with `tasks.superseded_by_task_id` set atomically on the prior owner.
  - Guard/status semantic redesign is explicitly a follow-up and is out of scope here.
- SAM idea `01M18P09B2ER9DB4F1RSN4TZP4`:
  - Counting surfaces must stop treating task status alone as "active agent".
  - Display states should distinguish working, awake-idle, sleeping, and superseded.
  - Session-ledger repair is broader follow-up work; this task covers the marker and counting surfaces only.
- Current `main` already contains PR #1938 / direct-child-aware supersession liveness. Do not implement against older idea claims.

## Research findings

- `apps/api/src/services/session-recovery.ts:createRecoveryTask()` performs the real handoff in one D1 `batch()`:
  1. inserts the successor recovery task,
  2. clears `tasks.chat_session_id` on the previous session owner,
  3. clears `workspaces.chat_session_id`,
  4. binds `tasks.chat_session_id` to the successor,
  5. writes a status event for the successor.
- The predecessor-clearing statement already targets the exact prior owner because `chat_session_id` is unique for non-null task rows and the predicate is `(id = sourceTaskId OR recovery_source_task_id = sourceTaskId)`.
- `apps/api/src/services/task-runtime-liveness.ts:loadTaskSupersession()` defines the current family semantics:
  - same project,
  - newer `session-recovery` owner,
  - `owner.created_at > self.created_at`,
  - owner is either root-collapsed sibling or direct child.
- `apps/api/src/routes/mcp/workspace-tools-direct.ts:handleListProjectAgents()`, `apps/api/src/routes/dashboard.ts`, and `apps/api/src/routes/account-map.ts` all currently derive active task populations locally from active status sets.
- `apps/web/src/components/ActiveTaskCard.tsx` renders only an Active/Idle indicator; it does not show a sleeping active-task state and currently glows any `in_progress` task.
- Existing tests to extend:
  - `apps/api/tests/integration/session-recovery-handoff.test.ts` already drives the real `ensureSessionRecovery()`/`createRecoveryTask()` batch.
  - `apps/api/tests/unit/routes/dashboard.test.ts`
  - `apps/api/tests/unit/routes/account-map.test.ts`
  - `apps/api/tests/unit/routes/mcp.test.ts`
  - `apps/web/tests/unit/components/active-task-card.test.tsx`
  - Playwright dashboard audit coverage in `apps/web/tests/playwright/`.

## Writer inventory required by rule 44

Columns touched in this task:

- New `tasks.superseded_by_task_id`
  - New D1 migration backfill writes existing superseded predecessors once.
  - `session-recovery.ts:createRecoveryTask()` writes the marker in the same transactional batch as the existing predecessor `chat_session_id` handoff.
  - `session-recovery.ts:abandonRecoveryHandoff()` clears the marker only when it restores the original chat owner after a revoked handoff.
  - `session-recovery-authority.ts:restoreSessionRecoveryHandoff()` clears the marker only when it restores the original chat owner after a failed replacement still owns the snapshot claim.
  - `session-recovery-authority.ts:failAndRestoreSessionRecoveryHandoff()` clears the marker only when it restores the original chat owner after a definite runner-start failure.
  - No other writer should write this column in this task.
- Existing `tasks.chat_session_id`
  - This task edits only the existing `createRecoveryTask()` predecessor-null statement to add `superseded_by_task_id`.
  - Existing major production writers/nullers to enumerate in the PR:
    - `routes/chat.ts`
    - `routes/chat-start.ts`
    - `routes/chat-stop.ts`
    - `routes/workspaces/crud.ts`
    - `routes/workspaces/runtime.ts`
    - `routes/mcp/task-tools.ts`
    - `routes/mcp/orchestration-tools.ts`
    - `routes/mcp/orchestration-comms.ts`
    - `routes/mcp/dispatch-tool.ts`
    - `services/session-recovery.ts`
    - `services/session-recovery-authority.ts`
    - `services/trial/trial-runner.ts`
    - `services/task-runner-do.ts`
    - `services/trigger-submit.ts`
    - `durable-objects/task-runner/state-machine.ts`
    - `durable-objects/project-orchestrator/scheduling.ts`
    - `durable-objects/vm-agent-container-recovery.ts`
    - `durable-objects/sam-session/tools/dispatch-task.ts`
    - `durable-objects/sam-session/tools/retry-subtask.ts`
  - Out of scope: changing terminal writers, task status semantics, source-task guard predicates, or existing non-handoff `chat_session_id` writers.

## Implementation checklist

- [x] Add additive D1 migration `0130_task_supersession_marker.sql`:
  - [x] `ALTER TABLE tasks ADD COLUMN superseded_by_task_id TEXT`
  - [x] partial index on non-null `superseded_by_task_id`
  - [x] backfill non-terminal, chat-unbound predecessors with the earliest later same-family `session-recovery` owner.
  - [x] no `DROP`, no `DELETE`, no unbounded destructive update.
- [x] Update Drizzle schema for `tasks.supersededByTaskId` and its index.
- [x] Update `createRecoveryTask()` so the exact predecessor row that loses `chat_session_id` also receives `superseded_by_task_id = <successor task id>` in the same D1 batch and under the same predicate.
- [x] Do not change task status semantics, terminal writers, `sourceTaskGuardCondition`, `sourceTaskGuardIsWakeable`, `isSessionRecoverySourceTaskGuardValid`, or the `createRecoveryTask()` CAS status clause.
- [x] Add/extend real-writer tests:
  - [x] real `ensureSessionRecovery()` batch marks the predecessor with the successor id,
  - [x] owner-path control proves valid handoff still works,
  - [x] terminal/invalid source control proves marker is not written when handoff is refused,
  - [x] cross-project control uses a real SQL engine.
- [x] Add migration/backfill tests against a real SQLite engine:
  - [x] 29-link production-shaped chain,
  - [x] shared-source siblings,
  - [x] root-collapse variants,
  - [x] directionality control,
  - [x] cross-project control,
  - [x] terminal and chat-bound rows not backfilled.
- [x] Add shared API service for task agent-activity derivation:
  - [x] states: `working`, `awake-idle`, `sleeping`, `superseded`,
  - [x] sleeping requires restorable `session_snapshots.sleep_status = 'sleeping'`,
  - [x] superseded is `tasks.superseded_by_task_id IS NOT NULL`,
  - [x] active/listing filters exclude superseded rows through this service.
- [x] Consume the shared service from:
  - [x] MCP `list_project_agents` in `workspace-tools-direct.ts`,
  - [x] `GET /api/dashboard/active-tasks`,
  - [x] `GET /api/account-map`.
- [x] Add response state:
  - [x] MCP agent objects carry `state`,
  - [x] dashboard tasks carry `agentActivityState`,
  - [x] account-map tasks carry `agentActivityState`.
- [x] Update minimal web UI:
  - [x] `ActiveTaskCard` renders Sleeping distinctly from Active/Idle,
  - [x] sleeping cards do not get the active running glow.
- [x] Add/extend route, service, and UI tests proving superseded rows are not returned/counted and sleeping rows are marked.
- [x] Run migration safety: `pnpm quality:migration-safety`.
- [x] Run local Playwright screenshots for dashboard active-task cards at 375x667 and 1280x800 with stress data.
- [x] Verify discriminating tests by temporarily deleting the exclusion predicate and confirming the new tests fail, then restore it.
- [x] Coordinate staging per rule 13 before triggering `deploy-staging.yml`.
- [x] After staging deploy, report before/after staging D1 counts:
  - [x] raw `tasks.status='in_progress'`,
  - [x] superseded predecessor count,
  - [x] endpoint counts returned after the fix.
- [ ] Verify real `/mcp` `list_project_agents` on staging excludes superseded rows and marks sleeping.
  - Blocked for live staging fixture seeding: the available Cloudflare token can read D1 but cannot write D1 or KV, and the public API has no safe task-scoped MCP token producer that avoids starting a real agent/workspace session. Local MCP route tests cover the real handler and shared service contract.
- [ ] Append a short "what shipped" note to idea `01M0SG7ZEE1XARK4QDG7V6HDPN`.

## Staging verification evidence

- Initial staging deploy `33302909856` for branch `sam/record-task-supersession-explicitly-nadfhg` passed with 12 smoke tests, but staging was overwritten afterward by the parallel session-ledger repair deploy `33304340445`.
- Rechecked staging queue: no queued/in-progress deploys. Redeployed this branch in `33305022102` at head SHA `2b38130f58a67eb59c9593bc3f517afab1c27f9a`; deploy and 12 smoke tests passed.
- Staging D1 baseline after redeploy:
  - `raw_in_progress=0`
  - `raw_active_statuses=0`
  - `raw_active_superseded=0`
  - `endpoint_active_equivalent=0`
  - `restorable_sleeping_snapshot_candidates=2`
- Disposable dashboard fixture project `01M1923BB7ZEKQAGDEQ8KAZHR9` created three active-status tasks. D1 during fixture: `global_in_progress=1`, `global_active_statuses=3`, `global_active_superseded=0`, `fixture_in_progress=1`, `fixture_active_statuses=3`, `fixture_endpoint_equivalent=3`. `/api/dashboard/active-tasks` returned the three fixture tasks with `agentActivityState=working` for queued/delegated and `agentActivityState=awake-idle` for in-progress without a running workspace. Project deletion returned fixture D1 counts to zero.
- Disposable account-map fixture project `01M1928YBNJRE86GMGPBNRRV38` created one queued task. D1 during fixture: `fixture_active_statuses=1`, `fixture_endpoint_equivalent=1`. `/api/account-map?activeOnly=true` returned one fixture task with `agentActivityState=working`; no superseded tasks were returned. Project deletion returned fixture D1 counts to zero.

## Acceptance criteria

- `tasks.superseded_by_task_id` exists with an index and is populated in production-compatible historical shapes by the migration backfill.
- The real `createRecoveryTask()` batch writes `superseded_by_task_id` atomically on the same predecessor row whose `chat_session_id` it clears.
- No task status semantics, terminal writers, or source-task guard predicates change in this PR.
- Dashboard active tasks, account-map active task data, and MCP `list_project_agents` all exclude superseded rows through one shared derivation service.
- Returned active agents/tasks carry working/awake-idle/sleeping state where applicable.
- `ActiveTaskCard` displays sleeping state distinctly and passes mobile/desktop Playwright screenshot review with stress data.
- Real-SQL tests cover marker/backfill predicates, including directionality and cross-project controls.
- `pnpm quality:migration-safety`, relevant targeted tests, full quality suite, staging deploy, staging D1 checks, PR CI, merge, and production deploy monitoring complete before task completion. Real staging `/mcp` fixture verification remains explicitly blocked by D1/KV write permissions for disposable token/task seeding; local MCP tests cover this handler.

## References

- `apps/api/src/services/session-recovery.ts`
- `apps/api/src/services/task-runtime-liveness.ts`
- `apps/api/src/routes/mcp/_helpers.ts`
- `apps/api/src/routes/mcp/workspace-tools-direct.ts`
- `apps/api/src/routes/dashboard.ts`
- `apps/api/src/routes/account-map.ts`
- `apps/web/src/components/ActiveTaskCard.tsx`
- `.claude/rules/66-ownership-handoff-must-record-the-supersession.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/13-staging-verification.md`
- `tasks/archive/2026-08-24-superseded-task-killed-after-successful-wake.md`
- `tasks/archive/2026-08-25-fix-stuck-task-supersession-toctou.md`
- `tasks/archive/2026-08-26-decouple-vm-liveness-projectdata.md`
