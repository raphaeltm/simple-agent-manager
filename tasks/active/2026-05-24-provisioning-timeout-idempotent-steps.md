# Fix: Task Runner Provisioning Timeout & Idempotent Step Updates

## Problem

Tasks get stuck in "Queued / Setting up a new server..." for days. Two cooperating bugs cause this:

**Bug 1 (Belt):** `handleNodeProvisioning` has no timeout. Unlike `handleNodeAgentReady` (which tracks `agentReadyStartedAt` and throws after `TASK_RUNNER_AGENT_READY_TIMEOUT_MS`) and `handleWorkspaceReady` (which tracks `workspaceReadyStartedAt`), `handleNodeProvisioning` polls forever when a node stays in `creating` status.

**Bug 2 (Suspenders):** `updateD1ExecutionStep` refreshes `updated_at` on every poll cycle, even when the step hasn't changed. The stuck-tasks cron (`scheduled/stuck-tasks.ts`) uses `elapsed = now - updated_at` to detect stuck tasks. Since the DO refreshes `updated_at` every poll, the cron never sees these tasks as stale — defeating the safety net.

## Research Findings

### Existing timeout patterns (to mirror)
- `handleNodeAgentReady` (`node-steps.ts:237-310`): tracks `agentReadyStartedAt`, checks against `getAgentReadyTimeoutMs()`, throws permanent error on timeout
- `handleWorkspaceReady` (`workspace-steps.ts`): tracks `workspaceReadyStartedAt`, similar pattern
- Both initialized on first entry: `if (!state.agentReadyStartedAt) { state.agentReadyStartedAt = Date.now(); await rc.ctx.storage.put('state', state); }`

### Existing config patterns (to mirror)
- Constants in `packages/shared/src/constants/task-execution.ts` with `DEFAULT_TASK_RUNNER_*` prefix
- Env vars in `apps/api/src/env.ts` with `TASK_RUNNER_*_MS` suffix
- Config methods on TaskRunner class: `private getXxxMs(): number { return parseEnvInt(this.env.TASK_RUNNER_XXX_MS, DEFAULT_TASK_RUNNER_XXX_MS); }`
- Exposed via `TaskRunnerContext` interface

### The cron gap (Bug 2 detail)
- `stuck-tasks.ts:241`: `const elapsedMs = now.getTime() - updatedAt;` — uses `updated_at` as staleness indicator
- `updateD1ExecutionStep` (`index.ts:253-256`): `UPDATE tasks SET execution_step = ?, updated_at = ? WHERE id = ?` — unconditionally writes even if step unchanged
- Every `handleNodeProvisioning` call starts with `await rc.updateD1ExecutionStep(state.taskId, 'node_provisioning')` — refreshes `updated_at` every poll

## Implementation Checklist

### Belt fix: Provisioning timeout
- [ ] Add `DEFAULT_TASK_RUNNER_PROVISION_TIMEOUT_MS` (15 min = 900_000) to `packages/shared/src/constants/task-execution.ts`
- [ ] Export from `packages/shared/src/constants/index.ts`
- [ ] Add `TASK_RUNNER_PROVISION_TIMEOUT_MS?: string` to `Env` in `apps/api/src/env.ts`
- [ ] Add `provisioningStartedAt: number | null` to `TaskRunnerState` in `types.ts`
- [ ] Add `getProvisionTimeoutMs: () => number` to `TaskRunnerContext` in `types.ts`
- [ ] Initialize `provisioningStartedAt: null` in `start()` in `index.ts`
- [ ] Add backward compat normalization in `getState()` for `provisioningStartedAt`
- [ ] Add `private getProvisionTimeoutMs()` method to `TaskRunner` class
- [ ] Wire `getProvisionTimeoutMs` into `buildContext()`
- [ ] Add timeout check in `handleNodeProvisioning` — initialize `provisioningStartedAt` on first entry, check elapsed against timeout, throw permanent error if exceeded

### Suspenders fix: Idempotent step updates
- [ ] Add `lastD1Step` private field to `TaskRunner` class
- [ ] Guard `updateD1ExecutionStep` with `if (step === this.lastD1Step) return;` and set `this.lastD1Step = step` after write

### Tests
- [ ] Test: provisioning timeout fires after configured timeout
- [ ] Test: provisioning timeout does not fire within timeout window
- [ ] Test: provisioning timeout is configurable via context
- [ ] Test: idempotent step updates skip redundant D1 writes
- [ ] Test: step updates still write on step change

## Acceptance Criteria

- [ ] Tasks stuck in `node_provisioning` with a creating node are failed after 15 minutes (configurable)
- [ ] The stuck-tasks cron can detect tasks stuck in `node_provisioning` because `updated_at` is no longer refreshed on redundant step updates
- [ ] Existing timeout patterns (`handleNodeAgentReady`, `handleWorkspaceReady`) are not regressed
- [ ] All existing tests pass
- [ ] New tests cover the timeout and idempotency behavior

## References

- Previous session: 6b7c7140 (implemented but never pushed — workspace destroyed)
- `handleNodeAgentReady` pattern: `apps/api/src/durable-objects/task-runner/node-steps.ts:237-310`
- Stuck tasks cron: `apps/api/src/scheduled/stuck-tasks.ts`
- TaskRunner DO: `apps/api/src/durable-objects/task-runner/index.ts`
