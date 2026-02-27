# TDF-7: Recovery & Resilience — Safety Net for Durable Orchestration

**Created**: 2026-02-27
**Priority**: Medium (becomes less critical after TDF-2, but still necessary as defense-in-depth)
**Classification**: `business-logic-change`, `cross-component-change`
**Dependencies**: TDF-1 (Task State Machine), TDF-2 (Orchestration Engine)
**Blocked by**: TDF-1, TDF-2
**Blocks**: Nothing (but should be completed before TDF-8 for full reliability)

---

## Context

The stuck-task cron and node cleanup cron are currently the **primary recovery mechanisms** — they catch tasks that silently stall due to `waitUntil` death. After TDF-2 (Durable Object orchestration), the cron should become a **safety net**, not the main way tasks recover. But it still needs to exist and work correctly for defense-in-depth.

Our research identified two problems with current recovery:
1. The cron writes to `log.warn()` (Workers Observability logs) but NOT to the error database — so admin errors tab shows nothing for stuck task recoveries
2. When the cron fails a stuck task, it doesn't record the workspace status — making it impossible to determine which failure scenario occurred without manual investigation

### Research References

- **Flow map**: `docs/task-delegation-flow-map.md`
  - Section "Recovery & Resilience Mechanisms" — stuck task cron, provisioning timeout, optimistic locking
  - Section "Known Weak Points" #6 — no observability for silent waitUntil failures
  - Section "Recommended Fixes" P4, P5 — error database recording, workspace status logging
  - Section "Configuration Reference" — all timeout env vars
  - Section "Debugging Checklist" — manual investigation steps the cron should automate
- **Stuck task cron**: `apps/api/src/scheduled/stuck-tasks.ts`
- **Provisioning timeout**: `apps/api/src/services/timeout.ts`
- **Node cleanup cron**: `apps/api/src/scheduled/node-cleanup.ts`
- **Error recording**: Pattern from admin observability (spec 023)
- **NodeLifecycle DO**: `apps/api/src/durable-objects/node-lifecycle.ts` — three-layer defense

---

## Problem Statement

### Current Recovery Gaps

1. **Invisible recoveries**: When the cron recovers a stuck task, it calls `log.warn('stuck_task.recovering', ...)`. This goes to Workers Observability logs (7-day retention, requires manual log viewer). It does NOT write to the OBSERVABILITY_DATABASE error table. The admin errors tab — the primary place operators look — shows nothing.

2. **Missing diagnostic context**: The cron error message says "Task stuck in 'delegated' for Xs. Last step: workspace_ready." But it doesn't include:
   - What the workspace status was at recovery time (running? creating? error?)
   - What the node status was (running? warm? destroyed?)
   - Whether callbacks were received (was `/ready` ever called?)
   - This forces manual investigation for every stuck task

3. **Idempotency concerns**: The `failTask()` function is designed to be idempotent (skips if already terminal), but the cleanup (`cleanupTaskRun()`) runs best-effort and may partially execute. Running cleanup twice could cause issues (e.g., stopping an already-stopped workspace, marking a node warm that's already warm).

4. **Post-TDF-2 role change**: After the orchestration engine moves to a Durable Object, the cron needs to handle a different set of failure modes:
   - DO alarm didn't fire (Cloudflare issue — rare but possible)
   - DO state is corrupted
   - DO is healthy but external dependency is permanently down
   - The cron should also check DO health, not just D1 state

---

## Scope

### In Scope

- Write stuck-task recoveries to the error database (OBSERVABILITY_DATABASE)
- Record diagnostic context at recovery time (workspace status, node status, callback history)
- Ensure cleanup is fully idempotent (safe to run multiple times)
- Adapt cron for post-TDF-2 world (check DO health, not just D1 state)
- Test recovery for every combination of task status × execution step
- Test cleanup idempotency (run twice, no side effects)
- Test the three-layer node defense (DO alarm → cron sweep → max lifetime)
- Add orphan resource detection (workspaces running with no associated task, nodes with no workspaces)

### Out of Scope

- The orchestration engine itself (TDF-2)
- Task state machine changes (TDF-1)
- Frontend display of recovery events (TDF-8)

---

## Acceptance Criteria

- [ ] Stuck-task recoveries are recorded in OBSERVABILITY_DATABASE with severity, context, and diagnostic data
- [ ] Recovery records include: workspace status, node status, time since last execution step update, execution step at failure
- [ ] Recovered tasks appear in the admin errors tab
- [ ] Cleanup is fully idempotent: running `cleanupTaskRun()` twice produces no side effects
- [ ] Cleanup handles partial state: workspace already stopped, node already warm, session already ended
- [ ] Post-TDF-2: cron checks TaskRunner DO health for tasks with active DOs
- [ ] Post-TDF-2: cron handles DO-doesn't-exist case (task has DO ID but DO is gone)
- [ ] Orphan detection: workspaces running with no active task are flagged
- [ ] Orphan detection: nodes with no workspaces past warm timeout are flagged
- [ ] Node three-layer defense tested: DO alarm fires → cron sweep catches missed → max lifetime enforced
- [ ] Unit tests for every recovery scenario
- [ ] Integration tests for cleanup idempotency
- [ ] All tests pass in CI

---

## Recovery Scenarios to Test

| Task Status | Execution Step | Workspace Status | Expected Recovery |
|-------------|---------------|-----------------|-------------------|
| `queued` | `node_selection` | N/A (no workspace yet) | Fail task, no cleanup needed |
| `queued` | `node_provisioning` | N/A | Fail task, cancel Hetzner provisioning if possible |
| `queued` | `node_agent_ready` | N/A | Fail task, node may need cleanup |
| `delegated` | `workspace_creation` | `creating` | Fail task, stop workspace on node |
| `delegated` | `workspace_ready` | `creating` | Fail task, provisioning still in progress or callback failed |
| `delegated` | `workspace_ready` | `running` | **Most common**: Worker died. Workspace is fine. Fail task, stop workspace |
| `delegated` | `workspace_ready` | `error` | Provisioning failed on VM. Fail task, cleanup workspace record |
| `delegated` | `agent_session` | `running` | Agent session creation failed. Fail task, stop workspace |
| `in_progress` | `running` | `running` | Task exceeded max execution time. Fail task, stop agent + workspace |
| `in_progress` | `awaiting_followup` | `running` | Idle cleanup should have handled this. Fail task, stop workspace |

---

## Testing Requirements

### Unit Tests

| Test Category | What to Test |
|--------------|-------------|
| Stuck detection | Each status × threshold combination correctly identified |
| Error recording | Recovery events written to OBSERVABILITY_DATABASE with full context |
| Diagnostic data | Workspace + node status queried and included in error record |
| Timeout configurability | Custom thresholds from env vars override defaults |
| Idempotent failure | `failTask()` on already-failed task is no-op |

### Integration Tests (Miniflare)

| Test Category | What to Test |
|--------------|-------------|
| Cleanup idempotency | Run `cleanupTaskRun()` twice, verify no side effects |
| Cleanup with partial state | Workspace already stopped, node already warm |
| Orphan detection | Workspace running with no task → flagged |
| Node three-layer defense | DO alarm fires, cron sweep catches missed, max lifetime enforced |
| Full recovery flow | Stuck task → cron detects → fails → cleans up → error recorded |

### Scenario Tests

| Scenario | What to Verify |
|----------|---------------|
| Worker died at workspace_ready, workspace is running | Task failed, workspace stopped, error says "workspace was running" |
| Worker died at node_provisioning, node is booting | Task failed, node cleanup initiated |
| Task at max execution time, agent still running | Task failed, agent session stopped, workspace stopped |
| Cron fires twice for same stuck task | Second run is no-op (optimistic locking) |

---

## Key Files

| File | Action |
|------|--------|
| `apps/api/src/scheduled/stuck-tasks.ts` | Add error database recording, diagnostic context |
| `apps/api/src/services/timeout.ts` | Coordinate with stuck-task cron |
| `apps/api/src/scheduled/node-cleanup.ts` | Verify idempotency, add orphan detection |
| `apps/api/src/services/task-runner.ts` | Ensure `cleanupTaskRun()` is idempotent |
| `apps/api/src/durable-objects/node-lifecycle.ts` | Test three-layer defense |
| `apps/api/tests/unit/stuck-tasks.test.ts` | Create comprehensive unit tests |
| `apps/api/tests/integration/recovery.test.ts` | Create integration tests |
