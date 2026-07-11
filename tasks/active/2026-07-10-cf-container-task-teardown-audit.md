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

- [x] Add a shared task terminal cleanup helper that stops/fails ProjectData sessions and invokes `cleanupTaskRun()` for terminal task states.
- [x] Update `cleanupTaskRun()` so cf-container nodes call `stopNodeResources()`/`destroyVmAgentContainer()` deterministically and skip VM warm-node cleanup.
- [x] Update terminal task paths (`complete_task`, task callback, user status transition, stop_subtask, TaskRunner failure cleanup as needed) so cf-container task work receives runtime teardown for completed, failed, and cancelled states.
- [x] Add regression tests that assert cf-container cleanup invokes the runtime destroy path, not only task/workspace status updates.
- [x] Add regression tests for each changed terminal path proving cleanup is scheduled before/with terminal handling.
- [x] Evaluate and, if low-risk, add a bounded cf-container orphan sweep/max-lifetime path with Rule 47 I/O budget and escape path. If not added, document the reason and residual risk.
- [x] Run targeted API tests plus lint/typecheck/build gates required by `/do`.
- [x] Run specialist reviews: task-completion-validator, cloudflare-specialist, constitution-validator, test-engineer.
- [x] Deploy to staging with coordination checks, run a task-backed cf-container session through changed terminal states, and verify container teardown through Cloudflare API/log evidence.
- [ ] Update related SAM idea/backlog state with PR number and teardown evidence.

## Audit Results

| Terminal path | Pre-fix result | Post-fix result |
| --- | --- | --- |
| MCP `complete_task` (`apps/api/src/routes/mcp/task-tools.ts`) | Scheduled a local `stopSessionAndCleanup()` wrapper. Runtime cleanup depended on VM-oriented `cleanupTaskRun()` and did not destroy cf-container task nodes. | Awaits `cleanupTerminalTaskResources()` before reporting completion. `cleanupTaskRun()` now detects `nodes.runtime = 'cf-container'` and calls `stopNodeResources()`. |
| Task callback terminal statuses (`apps/api/src/routes/tasks/callback.ts`) | `completed` called `cleanupTaskRun()`; `failed` and `cancelled` intentionally kept workspaces alive, which leaks paid cf-container task nodes. | All terminal statuses await `cleanupTerminalTaskResources()` with status/error context before returning terminal callback success. |
| User/API task status transition (`apps/api/src/routes/tasks/crud.ts`) | Stopped/failed ProjectData session only; no runtime cleanup. Staging delegated-cancel verification showed `cancelled` while cf-container node stayed `running` when cleanup was backgrounded. | All terminal statuses await `cleanupTerminalTaskResources()`; cleanup failure propagates instead of returning terminal success while the runtime remains alive. |
| SAM `stop_subtask` (`apps/api/src/durable-objects/sam-session/tools/stop-subtask.ts`) | Stopped agent session and marked task cancelled; no container destroy. | After cancellation DB update, calls `cleanupTerminalTaskResources()` and returns an error if runtime cleanup fails. |
| TaskRunner failure cleanup (`apps/api/src/durable-objects/task-runner/state-machine.ts`) | `cleanupOnFailure()` did VM stop/warm cleanup directly before delegating to `cleanupTaskRun()` for auto-provisioned nodes. | Detects cf-container nodes and routes through `cleanupTaskRun()` immediately, avoiding VM stop/warm behavior. |
| Session archive/close (`apps/api/src/routes/chat-stop.ts`) | Skipped workspace cleanup for task-linked sessions. | Task-linked stop cancels executable tasks when needed and calls `cleanupTerminalTaskResources()`. Taskless sessions still use `cleanupWorkspaceForDeletion()`. |
| Workspace deletion (`apps/api/src/services/workspace-cleanup.ts`) | Already routed cf-container workspaces to `stopNodeResources()`. | No change needed. |
| Workspace/project deletion via node cleanup | `deleteNodeResources()` did not destroy cf-container DOs. | Added a bounded scheduled safety sweep for terminal task-backed cf-container nodes that calls `stopNodeResources()`. |
| Idle/max lifetime | `VmAgentContainer` already has DO idle timeout and active-work max deadline. | Added D1-backed last-resort sweep: max `CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT` terminal task-backed cf-container candidates per cron run (default 25), one stop/destroy call each, successful stop marks node/workspaces deleted so candidates escape the set. |

## Verification

- `pnpm --filter @simple-agent-manager/api test -- tests/unit/services/task-runner-cleanup.test.ts tests/unit/routes/mcp-complete-task-cleanup.test.ts tests/unit/routes/task-callback-recoverable-error.test.ts tests/unit/durable-objects/sam-tools-phase-b.test.ts tests/unit/routes/chat-session-stop-cleanup.test.ts tests/unit/task-runner-completion.test.ts` — passed, 47 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/node-cleanup.test.ts tests/unit/services/task-runner-cleanup.test.ts tests/workers/scheduled-node-cleanup.test.ts` — passed, 14 tests.
- `pnpm --filter @simple-agent-manager/api test -- tests/unit/routes/mcp-complete-task-cleanup.test.ts tests/unit/routes/task-callback-recoverable-error.test.ts tests/unit/services/task-runner-cleanup.test.ts tests/unit/routes/chat-session-stop-cleanup.test.ts tests/unit/node-cleanup.test.ts` — passed after staging found background cleanup was insufficient, 25 tests.
- `pnpm --filter @simple-agent-manager/api test` — passed, 399 files / 5,888 tests.
- `pnpm --filter @simple-agent-manager/api typecheck` — passed.
- `pnpm --filter @simple-agent-manager/api build` — passed.
- `pnpm --filter @simple-agent-manager/api lint` — passed with existing warnings.
- `pnpm --filter @simple-agent-manager/api exec eslint ...changed files...` — passed with three existing non-null assertion warnings.
- `pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/scheduled-node-cleanup.test.ts` — blocked by `workerd` signal 11 before importing tests while loading `@cloudflare/containers`; no assertions ran.
- Staging run `https://github.com/raphaeltm/simple-agent-manager/actions/runs/29131354575` deployed `bf88767d8` successfully. Live verification created cf-container nodes `01KX788ZNFNV0D8FFWSZPFSC8S`, `01KX78FX70W108VR5NH1GAGFBS`, and `01KX78PZ339ABDN8F86MMRW138`; D1 confirmed all three reached `status='deleted'` after explicit session cleanup. A delegated terminal task (`01KX78QNH1JNT8FYDQ3CPH6WXK`) reproduced the remaining gap on the deployed build: task `cancelled`, workspace/node still `running` after the cleanup delay. Follow-up patch changed terminal routes from background `waitUntil()` to awaited cleanup.
- Staging run `https://github.com/raphaeltm/simple-agent-manager/actions/runs/29132642474` deployed `4190fc68f` successfully. Fixed-build verification created cf-container node `01KX79SMWCETHGBW8SDPHG14EF`, workspace `01KX79SN1T97P7FT4884ECKHPM`, and delegated task `01KX79TJ55K0PVAHT4AF47SJQQ`. Cancelling the delegated task returned `200`; D1 then showed task `cancelled`, workspace `stopped`, and node `status='deleted'` at `2026-07-11T00:39:35.022Z`. Observability `platform_errors` showed ACP activity for the same node/workspace before teardown, proving the container was live before cleanup.

## Specialist Review Evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | DEFERRED | Implementation checklist and local tests match the task file. Remaining task acceptance gap is staging verification: task-backed cf-container terminal paths still need live Cloudflare evidence before archive/complete. |
| cloudflare-specialist | PASS | D1 queries are parameterized, the cron sweep has a bounded configurable limit (`CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT`), candidates escape by `stopNodeResources()` marking node/workspaces deleted, and no Wrangler/migration changes are required. Local worker-pool verification is blocked by `workerd` signal 11 before import. |
| constitution-validator | PASS | New operational limit uses env override with default; no hardcoded URLs/timeouts/deployment identifiers added. Default value is isolated as `DEFAULT_CF_CONTAINER_TERMINAL_TASK_SWEEP_LIMIT`. |
| test-engineer | PASS | Runtime-boundary regression exists in `task-runner-cleanup.test.ts`; terminal entry-point delegation tests cover MCP completion, failed callbacks, SAM stop_subtask, and chat stop/archive; cron fallback test asserts `stopNodeResources()` and configured sweep limit. Staging remains required for live Cloudflare Container teardown. |

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
