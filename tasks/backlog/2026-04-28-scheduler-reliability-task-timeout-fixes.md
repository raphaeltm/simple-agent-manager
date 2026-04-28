# Fix Scheduler Reliability and Task Timeout Enforcement

**Created:** 2026-04-28
**Source:** Investigation task 01KQ98574Q0JA1DMH40N0SGMSZ — analysis of why tasks survive past their time limits

## Problem

Tasks are staying alive significantly longer than their configured time limits. Investigation identified five root causes spanning the TaskRunner DO, ProjectOrchestrator, mailbox system, and stuck-task cron.

## Root Causes

### RC-1: No Alarm-Based Execution Deadline in TaskRunner DO (CRITICAL)

**File:** `apps/api/src/durable-objects/task-runner/state-machine.ts:160-162`

When `transitionToInProgress()` is called, the DO sets `state.completed = true` and stops firing alarms. There is **no deadline alarm** set for the actual task execution phase. The TaskRunner DO has robust timeout enforcement for provisioning steps (node_agent_ready: 15min, workspace_ready: 30min) but **zero enforcement** once the agent starts running.

```typescript
// state-machine.ts:160-162
state.currentStep = 'running';
state.completed = true;          // <-- DO stops here, no deadline alarm
await rc.ctx.storage.put('state', state);
```

**Impact:** The DO — the component with the most reliable timer (Durable Object alarms) — abandons oversight at exactly the moment it's most needed.

### RC-2: Stuck-Task Cron Heartbeat Bypass (CRITICAL)

**File:** `apps/api/src/scheduled/stuck-tasks.ts:242-284`

The cron-based stuck task recovery is the only remaining wall-clock timeout for `in_progress` tasks (default: 4 hours via `TASK_RUN_MAX_EXECUTION_MS`). However, it explicitly **skips** any task whose VM node has a recent heartbeat:

```typescript
// stuck-tasks.ts:251-276
const heartbeatRecent = await isNodeHeartbeatRecent(env, nodeIdToCheck, staleSeconds);
if (heartbeatRecent) {
  // SKIP RECOVERY — task keeps running indefinitely
  result.heartbeatSkipped++;
  break;
}
```

The node heartbeat comes from the VM agent, which sends heartbeats as long as the **node** is alive — completely independent of whether the **task** is making progress or has exceeded its time limit. A task on a healthy node will **never** be terminated by the cron, no matter how long it runs.

**Impact:** The safety-net timeout is defeated by a condition (node health) unrelated to the question being asked (has the task exceeded its time limit?).

### RC-3: Orchestrator Stall Detection Filters for Non-Existent Status (CRITICAL)

**File:** `apps/api/src/durable-objects/project-orchestrator/scheduling.ts:448-450`

The `detectStalls()` function filters tasks by `t.status === 'running'`, but **there is no `running` task status** in the system. Valid statuses are: `draft`, `ready`, `queued`, `delegated`, `in_progress`, `completed`, `failed`, `cancelled`. An active agent task is in `in_progress` status. The filter should use `in_progress` instead of `running`.

```typescript
// scheduling.ts:448-450
const runningTasks = tasks.filter(
  (t) => t.status === 'running' || t.status === 'delegated',
);
// 'running' matches ZERO tasks — stall detection for active agents is completely dead
```

Note: the `autoDispatchSchedulableTasks` concurrency check (line 177) correctly uses `'in_progress'` in its `IN` clause, making this inconsistency even more evident.

**Impact:** Stall detection for mission-managed tasks is completely non-functional for active agents. Only `delegated` tasks (pre-agent-start) can be detected as stalled.

### RC-4: Interrupt Messages Are Purely Advisory — No Escalation to Hard Stop (HIGH)

**Files:**
- `apps/api/src/durable-objects/project-data/mailbox.ts` (delivery system)
- `apps/api/src/durable-objects/project-orchestrator/scheduling.ts:466-477` (stall handler)

When a stall is detected, the orchestrator sends an `interrupt`-class mailbox message. This message:
1. Requires the agent to actively call `get_pending_messages` to receive it
2. Must be acknowledged via `ack_message`
3. If never acked: re-delivered up to 5 times over ~25 minutes, then expires silently
4. **No escalation occurs** — there is no code path that escalates an expired/ignored interrupt to a hard stop (`stop_subtask`)

The `stop_subtask` tool exists (in `orchestration-comms.ts:315-439`) and performs a real hard kill via `stopAgentSessionOnNode()`, but nothing in the orchestrator's stall detection path calls it.

**Impact:** An agent that ignores its mailbox (or is stuck in a loop that doesn't call MCP tools) is completely immune to stall-based termination.

### RC-5: No Execution Timeout on Non-Mission Tasks (MEDIUM)

Tasks dispatched outside of missions (direct user submission) have no orchestrator oversight at all. Their only timeout enforcement is:
1. The TaskRunner DO (which stops at `running` — see RC-1)
2. The stuck-task cron (which is bypassed by heartbeats — see RC-2)

This means non-mission tasks on healthy nodes can run indefinitely past the 4-hour default.

## Recommended Fixes

### Fix 1: Add Deadline Alarm to TaskRunner DO (addresses RC-1)

In `transitionToInProgress()`, instead of setting `state.completed = true`, set a deadline alarm:

```typescript
// In transitionToInProgress():
const maxExecutionMs = state.config.projectScaling?.taskExecutionTimeoutMs
  ?? parseEnvInt(rc.env.TASK_RUN_MAX_EXECUTION_MS, DEFAULT_TASK_RUN_MAX_EXECUTION_MS);

state.currentStep = 'running';
state.executionDeadline = Date.now() + maxExecutionMs;  // new field
// DO NOT set state.completed = true yet
await rc.ctx.storage.put('state', state);
await rc.ctx.storage.setAlarm(state.executionDeadline);
```

In the `alarm()` handler, add handling for the `running` step:

```typescript
case 'running':
  if (state.executionDeadline && Date.now() >= state.executionDeadline) {
    await failTask(state, 'Task exceeded maximum execution time', rc);
  }
  return;
```

### Fix 2: Remove Heartbeat Bypass from Stuck-Task Cron (addresses RC-2)

The heartbeat check in `stuck-tasks.ts` should NOT prevent termination of tasks past `TASK_RUN_MAX_EXECUTION_MS`. A healthy node does not mean the task should run forever. Either:
- Remove the heartbeat bypass entirely, OR
- Only use the heartbeat check to EXTEND the timeout by a bounded grace period (e.g., +30 minutes), not to skip recovery entirely

### Fix 3: Fix Status Filter in detectStalls() (addresses RC-3)

Change `scheduling.ts:448-450` from:
```typescript
const runningTasks = tasks.filter(
  (t) => t.status === 'running' || t.status === 'delegated',
);
```
To:
```typescript
const runningTasks = tasks.filter(
  (t) => t.status === 'in_progress' || t.status === 'delegated',
);
```

### Fix 4: Add Escalation Path for Ignored Interrupts (addresses RC-4)

After an interrupt message expires without acknowledgment, the orchestrator should escalate to a hard stop. Options:
- **Option A:** In the scheduling cycle, check for expired stall interrupts and call `stop_subtask` for those tasks
- **Option B:** After N unacked stall interrupts for the same task, send a `shutdown_with_final_prompt` message followed by a hard stop after a grace period
- **Option C:** Add a new `deadline_exceeded` action that directly calls `stopAgentSessionOnNode()` without going through the mailbox

### Fix 5: Ensure Cron Covers All Task Types (addresses RC-5)

With Fix 1 implemented, the TaskRunner DO deadline alarm covers both mission and non-mission tasks. The cron remains as a safety net but should not be the primary enforcement mechanism.

## Acceptance Criteria

- [ ] TaskRunner DO sets a deadline alarm when entering `running` state
- [ ] Deadline alarm fires and fails the task when execution time is exceeded
- [ ] `detectStalls()` correctly filters for `in_progress` tasks (not `running`)
- [ ] Stuck-task cron does not indefinitely skip tasks with active heartbeats
- [ ] Ignored stall interrupts escalate to hard task termination
- [ ] Unit tests cover: deadline alarm fires at correct time, heartbeat does not bypass time limit, stall detection finds in_progress tasks
- [ ] Integration test: task that exceeds max execution time is terminated even on a healthy node

## Risk Assessment

- **Fix 3 is zero-risk** — it's a clear bug fix (wrong status string)
- **Fix 1 is medium-risk** — changes TaskRunner DO state machine; needs careful testing of the alarm handler and interaction with `complete_task` (race between agent completing and deadline firing)
- **Fix 2 is medium-risk** — may terminate tasks that are genuinely still working but slow; consider a bounded grace period rather than complete removal
- **Fix 4 is higher-complexity** — requires new orchestrator logic and cross-DO communication
