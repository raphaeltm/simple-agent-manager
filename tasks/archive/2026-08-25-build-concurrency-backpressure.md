# Add VM build concurrency backpressure

## Problem

VM nodes can receive multiple concurrent devcontainer build requests while the control plane still sees the node as lightly loaded. Those builds saturate CPU, starve the VM agent heartbeat loop, and cause false `node_not_live` task failures.

## Research findings

- VM workspace creation enters asynchronous provisioning in `packages/vm-agent/internal/server/workspaces.go` through `handleAsyncWorkspaceCreate()` and `startWorkspaceProvision()`.
- Heartbeats are built in `packages/vm-agent/internal/server/health.go` and currently report `activeWorkspaces` from running/recovery states only.
- TaskRunner waits for workspace readiness in `apps/api/src/durable-objects/task-runner/workspace-steps.ts` using `workspaceReadyStartedAt` and `DEFAULT_TASK_RUNNER_WORKSPACE_READY_TIMEOUT_MS`.
- VM agent callback routes must use callback JWT auth and be mounted before `projectsRoutes`.
- Heartbeat fields must remain additive so old agents continue to work.
- Cross-boundary HTTP calls require tests for path, auth, and body shape.

## Checklist

- [x] Add a VM-agent build queue that serializes dynamic devcontainer provisioning per node.
- [x] Count queued plus active creating workspaces in the VM-agent heartbeat payload.
- [x] Add an authenticated build-started callback from VM agent to the API Worker.
- [x] Add TaskRunner DO handling that resets the workspace-ready timeout when the build actually starts.
- [x] Wire task/project identity into VM-agent workspace create payloads.
- [x] Update API route reference for the callback endpoint.
- [x] Add VM-agent unit tests for serialized builds and creating workspace count.
- [x] Add API contract/integration tests for callback auth/routing, TaskRunner timeout reset, and old heartbeat compatibility.

## Acceptance criteria

- Only one dynamic devcontainer build provisions at a time per VM agent process.
- VM agent heartbeats add `creatingWorkspaces` without breaking old-agent heartbeat handling.
- VM agent sends a callback when a queued build starts, using callback JWT Bearer auth.
- TaskRunner resets its workspace-ready timeout from that callback.
- Required Go and TypeScript tests cover the new behavior.

---

_Reconciled 2026-09-30 (weekly queue reconciliation): moved from `tasks/backlog/` to `tasks/archive/` as shipped. Evidence: PR #1904 (1d7fab947): build semaphore server.go:583, creatingWorkspaces health.go:169, build-started callback, TaskRunner reset, TS+Go tests; cited by scaling.ts:69 and generate.test.ts:560 -> archive + repoint._
