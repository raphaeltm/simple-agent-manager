# Fix Task Runner Agent Ready Timeout for Freshly Provisioned Nodes

## Problem

Tasks consistently fail with `Node agent not ready within 120000ms` when no existing/warm nodes are available. The TaskRunner DO auto-provisions a new Hetzner VM, but the agent-ready timeout (120 seconds) is too short for a cold-start node where cloud-init must complete (install Docker, pull images, start VM agent).

This has been reported as a recurring issue despite previous fix attempts.

## Root Cause

Two separate code paths wait for VM agent readiness with **different timeouts**:

| Code Path | Timeout | Used When |
|-----------|---------|-----------|
| `TaskRunner DO` (`task-runner.ts:handleNodeAgentReady()`) | **120,000ms (2 min)** | Task execution (auto-provisioned nodes) |
| `waitForNodeAgentReady()` (`node-agent.ts`) | **600,000ms (10 min)** | Manual workspace creation |

The DO path uses `DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS = 120_000` from `packages/shared/src/constants.ts:169`. For freshly provisioned nodes, after Hetzner reports "running", the VM still needs:
- Boot + cloud-init execution (2-5 min typically)
- Docker installation and agent image pull
- VM agent startup on port 8080

120 seconds is insufficient. The error is marked `{ permanent: true }`, so it immediately fails the task with no retry.

## Research Findings

- **Constant**: `packages/shared/src/constants.ts:169` — `DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS = 120_000`
- **DO timeout check**: `apps/api/src/durable-objects/task-runner.ts:494-501` — throws permanent error on timeout
- **Service timeout**: `apps/api/src/services/node-agent.ts:8` — `DEFAULT_NODE_AGENT_READY_TIMEOUT_MS = 600_000`
- **Env var override**: `TASK_RUNNER_AGENT_READY_TIMEOUT_MS` (but default should be reasonable)
- **Previous fix attempt**: Archived task `2026-03-07-fix-task-timeout-and-agent-offline-ux.md` references commit d93a39c bumping 120s→600s, but the constant is still 120_000 — fix may not have been merged or was reverted

## Implementation Checklist

- [ ] Increase `DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS` from `120_000` to `600_000` in `packages/shared/src/constants.ts` to match the service-level timeout
- [ ] Update the comment to explain why 10 minutes (fresh VM cloud-init can take 3-5+ minutes)
- [ ] Update `apps/api/.env.example` comment to reflect new default
- [ ] Update the integration test in `apps/api/tests/integration/task-runner-do-infra.test.ts` that validates the constant value
- [ ] Rebuild shared package and verify no typecheck/lint issues
- [ ] Run existing tests and verify they pass
- [ ] Add/update test that verifies the timeout constant matches the service-level timeout (no divergence)

## Acceptance Criteria

- [ ] `DEFAULT_TASK_RUNNER_AGENT_READY_TIMEOUT_MS` is 600_000 (10 minutes)
- [ ] Both agent-ready timeout paths use the same default value
- [ ] All existing tests pass
- [ ] `.env.example` reflects the new default
- [ ] Integration test updated for new constant value

## References

- `packages/shared/src/constants.ts:169` — timeout constant
- `apps/api/src/durable-objects/task-runner.ts:481-549` — DO agent-ready handler
- `apps/api/src/services/node-agent.ts:8` — service-level timeout (600_000)
- `apps/api/tests/integration/task-runner-do-infra.test.ts` — infra tests
- `tasks/archive/2026-03-07-fix-task-timeout-and-agent-offline-ux.md` — previous fix attempt
