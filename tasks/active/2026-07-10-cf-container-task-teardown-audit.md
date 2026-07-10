# Teardown Audit for Task-Backed CF Container Sessions

## Problem

Cloudflare Container-backed SAM workspaces (`runtime = 'cf-container'`) run a standalone VM agent inside a paid Cloudflare Container. Taskless instant sessions already destroy the container on creation failure and workspace deletion, but task-backed sessions can reach terminal task states through TaskRunner/MCP/status/callback paths that were originally written for VM-backed warm-node cleanup. A terminal DB status update is not sufficient: the Cloudflare Container Durable Object must receive a stop/destroy runtime command so billing stops deterministically.

## Research Findings

- `apps/api/src/services/vm-agent-container.ts:destroyVmAgentContainer()` calls the `VmAgentContainer` Durable Object `destroyForUser()` runtime boundary.
- `apps/api/src/durable-objects/vm-agent-container.ts:destroyForUser()` marks active work ended, sets lifecycle status to `stopping`, then calls `this.destroy()`.
- `apps/api/src/services/nodes.ts:stopNodeResources()` already destroys `runtime = 'cf-container'` nodes via `destroyVmAgentContainer()` and then marks the node and workspaces deleted.
- `apps/api/src/services/workspace-cleanup.ts:cleanupWorkspaceForDeletion()` already routes workspace/session deletion for cf-container nodes to `stopNodeResources()`, so explicit workspace deletion/session close for taskless work has a runtime teardown.
- `apps/api/src/services/task-runner.ts:cleanupTaskRun()` stops the workspace through `stopWorkspaceOnNode()`, schedules delayed workspace deletion, and marks auto-provisioned nodes warm through `NodeLifecycle`. That is correct for reusable VM nodes but wrong for standalone cf-container task nodes: a cf-container node should be destroyed, not warmed.
- `apps/api/src/routes/mcp/task-tools.ts:handleCompleteTask()` reaches terminal `completed`, then schedules `stopSessionAndCleanup()` in `waitUntil()`, which calls `cleanupTaskRun()`.
- `apps/api/src/durable-objects/task-runner/state-machine.ts:failTask()` calls `cleanupOnFailure()` after marking the task failed. `cleanupOnFailure()` currently stops workspaces and delegates auto-provisioned-node cleanup to `cleanupTaskRun()`, so fixing `cleanupTaskRun()` covers the durable failure path, but the direct stop step remains VM-oriented.
- `apps/api/src/routes/tasks/callback.ts` only calls `cleanupTaskRun()` on `completed`; `failed` and `cancelled` keep workspaces alive for debugging. For cf-container task nodes, keeping a paid standalone container alive until idle timeout is the leak risk and needs deterministic teardown.
- `apps/api/src/routes/tasks/crud.ts` terminal status updates stop/fail the ProjectData session but do not call `cleanupTaskRun()` at all.
- `apps/api/src/durable-objects/sam-session/tools/stop-subtask.ts` stops the agent session and marks the task cancelled, but does not destroy/cleanup the backing workspace/container.
- `apps/api/src/durable-objects/project-data/reconciliation-dead-target.ts` and `attention-expiry.ts` already call `cleanupTaskRun()` after failure cleanup, so fixing `cleanupTaskRun()` covers those idle/dead-target paths.
- `apps/api/src/durable-objects/vm-agent-container.ts` has a DO-level idle timeout and active-work max deadline (`DEFAULT_CF_CONTAINER_ACTIVE_WORK_MAX_MS`), but there is no D1-backed last-resort cron sweep for orphaned cf-container nodes whose DO cleanup was missed.

## Implementation Checklist

- [ ] Add a shared task terminal cleanup helper that stops/fails ProjectData sessions and invokes `cleanupTaskRun()` for terminal task states.
- [ ] Update `cleanupTaskRun()` so cf-container nodes call `stopNodeResources()`/`destroyVmAgentContainer()` deterministically and skip VM warm-node cleanup.
- [ ] Update terminal task paths (`complete_task`, task callback, user status transition, stop_subtask, TaskRunner failure cleanup as needed) so cf-container task work receives runtime teardown for completed, failed, and cancelled states.
- [ ] Add regression tests that assert cf-container cleanup invokes the runtime destroy path, not only task/workspace status updates.
- [ ] Add regression tests for each changed terminal path proving cleanup is scheduled before/with terminal handling.
- [ ] Evaluate and, if low-risk, add a bounded cf-container orphan sweep/max-lifetime path with Rule 47 I/O budget and escape path. If not added, document the reason and residual risk.
- [ ] Run targeted API tests plus lint/typecheck/build gates required by `/do`.
- [ ] Run specialist reviews: task-completion-validator, cloudflare-specialist, constitution-validator, test-engineer.
- [ ] Deploy to staging with coordination checks, run a task-backed cf-container session through changed terminal states, and verify container teardown through Cloudflare API/log evidence.
- [ ] Update related SAM idea/backlog state with PR number and teardown evidence.

## Acceptance Criteria

- Every audited terminal path has a cited code-path result: runtime teardown call present, intentionally not applicable, or fixed in this task.
- Cf-container task terminal states (`completed`, `failed`, `cancelled`) deterministically call the Cloudflare Container destroy/stop runtime boundary.
- Regression tests fail if future changes only update DB status without invoking runtime teardown.
- Any new sweep/control loop has bounded candidate selection, bounded per-candidate cost, and a candidate escape path per `.claude/rules/47-control-loop-io-budget.md`.
- Staging evidence confirms a task-backed cf-container is removed after each terminal path changed by this task.

## Post-Mortem

- **What broke**: Task-backed cf-container sessions can reach terminal task states without a deterministic Cloudflare Container destroy command, risking paid container runtime lingering until idle/max lifetime.
- **Root cause**: Existing task cleanup was designed around VM warm-node reuse and workspace stop/delete TTLs. The standalone cf-container runtime reuses the same node/workspace abstractions but has different teardown economics and should not enter warm-node cleanup.
- **Timeline**: PR #1544 introduced the cf-container runtime. PR #1559 extended active-work keepalive, increasing the cost impact of missed teardown. This audit was requested on 2026-07-10.
- **Why it was not caught**: Lifecycle tests focused on DB state and VM cleanup semantics. Rule 02 now explicitly requires runtime-boundary assertions for lifecycle cleanup, but the cf-container task-backed paths need regression coverage.
- **Class of bug**: Runtime abstraction lifecycle drift: a new paid runtime reused old terminal-state cleanup paths that updated local state but did not prove external resource teardown.
- **Process fix**: Add tests and, if needed, rule/checklist updates requiring terminal task paths for each runtime to assert the external teardown command, not only DB status.

## References

- `.claude/rules/02-quality-gates.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `apps/api/src/services/task-runner.ts`
- `apps/api/src/services/vm-agent-container.ts`
- `apps/api/src/durable-objects/vm-agent-container.ts`
- `apps/api/src/services/workspace-cleanup.ts`
