# Task-Mode Inactivity Reconciliation with SAM Check-In

## Problem

Task-mode sessions can go silent without completing — the agent stops producing output but never calls `complete_task()` or `request_human_input()`. Currently, the only backstop is the 15-minute idle cleanup (session-level) and the 8-hour stuck-task cron. There is no mechanism to actively check on the agent and give it a chance to respond before cleanup.

## Goal

For task-mode sessions that become idle (no activity for 5 minutes) without an explicit `complete_task` or active `needs_input` attention marker, SAM should:

1. Send a visible orchestrator check-in message to the agent
2. Give the agent ~1 minute to respond
3. If no response, fail the task with a diagnostic reason and clean up

## Research Findings

### Key Files
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` — idle cleanup scheduling, workspace timeout
- `apps/api/src/durable-objects/project-data/attention.ts` — durable attention markers (needs_input, 2hr expiry)
- `apps/api/src/durable-objects/project-data/index.ts` — DO alarm handler, persistMessage, recalculateAlarm
- `apps/api/src/durable-objects/project-data/messages.ts` — persistMessage, persistSystemMessage
- `apps/api/src/durable-objects/migrations.ts` — DO SQLite migrations (next = 021)
- `apps/api/src/services/node-agent.ts` — sendPromptToAgentOnNode (HTTP POST to VM agent ACP)
- `apps/api/src/services/task-runner.ts` — cleanupTaskRun, cleanupAutoProvisionedNode
- `packages/shared/src/constants/index.ts` — shared constants

### Architecture Decisions
1. **Reconciliation lives in ProjectData DO alarm** — the alarm already multiplexes idle cleanup, heartbeat, attention expiry, and mailbox delivery. Adding reconciliation as another alarm candidate is the natural extension.
2. **Check-in message = user-role message with source metadata** — persisted via `persistMessage()` with `role='user'` so the agent treats it as a prompt. Add `tool_metadata` JSON with `source: 'sam_orchestrator'` for UI styling later.
3. **Candidate detection via DO SQLite** — query `idle_cleanup_schedule` (has task_id) joined with activity timestamps and attention markers. Task mode check requires D1 query.
4. **Response deadline via attention marker** — reuse the attention marker system with a new kind `reconciliation_checkin` and short expiry (~1 minute). The existing alarm expiry path handles failure.
5. **No loops** — once a reconciliation check-in is sent for a session, a marker prevents sending another until resolved.

### Exclusion Criteria
- Conversation mode tasks — only task mode gets aggressive reconciliation
- Completed/failed/cancelled tasks — already handled
- Active `needs_input` markers — human is already involved
- Sessions with unresolved `reconciliation_checkin` markers — prevent loops

## Implementation Checklist

### 1. Add shared constants
- [ ] Add `DEFAULT_TASK_RECONCILIATION_IDLE_MS = 5 * 60 * 1000` (5 minutes)
- [ ] Add `DEFAULT_TASK_RECONCILIATION_RESPONSE_DEADLINE_MS = 60 * 1000` (1 minute)

### 2. Add reconciliation module
- [ ] Create `apps/api/src/durable-objects/project-data/reconciliation.ts`
- [ ] Implement `getReconciliationCandidates(sql, env, db)` — queries active task-mode sessions idle for TASK_RECONCILIATION_IDLE_MS, excluding:
  - Sessions with active `needs_input` markers
  - Sessions with unresolved `reconciliation_checkin` markers
  - Sessions whose tasks are completed/failed/cancelled (D1 query)
  - Conversation-mode tasks (D1 query)
- [ ] Implement `processReconciliationCandidates(sql, env, db, ...)` — for each candidate:
  1. Persist a user-role check-in message with `source: sam_orchestrator` metadata
  2. Create a `reconciliation_checkin` attention marker with response deadline expiry
  3. Send the prompt to the VM agent via `sendPromptToAgentOnNode`
  4. Record activity event
- [ ] Implement `computeReconciliationAlarmTime(sql, env)` — returns the earliest time a reconciliation check should fire

### 3. Integrate with DO alarm handler
- [ ] Add `reconciliation.processReconciliationCandidates()` call in alarm handler
- [ ] Add `reconciliationTime` to `recalculateAlarm()` candidates
- [ ] When attention marker for `reconciliation_checkin` expires (no response), fail task and cleanup (extend existing expired marker handling)

### 4. Handle reconciliation attention marker expiry
- [ ] In alarm handler's expired marker processing, handle `reconciliation_checkin` kind:
  - Fail task in D1 with reason "Agent became unresponsive after SAM check-in"
  - Stop workspace in D1
  - Fail session
  - Record activity event with diagnostics
  - Trigger `cleanupTaskRun` for workspace/node cleanup

### 5. Ensure activity resets prevent false positives
- [ ] Verify `persistMessage()` already resets idle cleanup (it does via `resetIdleCleanup`)
- [ ] Verify `persistMessageBatch()` also resets (it does)
- [ ] When the agent responds after a check-in, the attention marker gets resolved by activity — verify `resolveAttentionMarkers` covers `reconciliation_checkin` kind

### 6. Tests
- [ ] Test candidate selection: only task-mode sessions selected
- [ ] Test candidate exclusion: conversation mode, completed tasks, active needs_input, existing checkin marker
- [ ] Test check-in message has correct metadata (source: sam_orchestrator, role: user)
- [ ] Test response deadline creates attention marker with correct expiry
- [ ] Test marker loop prevention: second reconciliation skipped when unresolved marker exists
- [ ] Test expiry path: task failed, workspace stopped, session failed, activity recorded
- [ ] Test agent response resolves marker and prevents failure
- [ ] Test complete_task before reconciliation: no reconciliation sent

## Acceptance Criteria

- [ ] Task-mode sessions idle for 5 minutes (configurable) receive a SAM orchestrator check-in
- [ ] Check-in is persisted as a user-role message with `source: sam_orchestrator` metadata
- [ ] Agent has 1 minute (configurable) to respond before task is failed
- [ ] If agent responds, normal flow continues (complete_task or needs_input)
- [ ] Conversation-mode sessions are never reconciled
- [ ] Sessions with active needs_input markers are not reconciled
- [ ] Each idle period gets at most one check-in (no loops)
- [ ] Completed/failed tasks are excluded from reconciliation
- [ ] Failed task reason is "Agent became unresponsive after SAM check-in"
- [ ] All tests pass locally

## References

- PR #1004 (branch `sam/execute-task-using-skill-01krhe`) — prerequisite work
- `apps/api/src/durable-objects/project-data/attention.ts` — attention marker pattern
- `apps/api/src/durable-objects/project-data/idle-cleanup.ts` — idle cleanup pattern
- `.claude/rules/06-technical-patterns.md` — credential lifecycle alignment
