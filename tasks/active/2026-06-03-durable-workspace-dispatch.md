# Durable Workspace Dispatch

## Problem

Workspace creation can hang until the broad 30-minute timeout if the TaskRunner Durable Object or Worker is interrupted after creating/linking the D1 workspace row but before the VM-agent dispatch is acknowledged and recorded in `workspaces.dispatched_at`.

## Research

- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` creates the workspace row, links `tasks.workspace_id`, calls the VM-agent, then writes `dispatched_at`.
- `handleWorkspaceCreation()` currently advances recovered delegated workspaces directly to `workspace_ready`, even when `dispatched_at` is null.
- `apps/api/src/durable-objects/task-runner/index.ts` owns the alarm step switch and retry config.
- `apps/api/src/services/node-agent.ts` sends `POST /workspaces`.
- `packages/vm-agent/internal/server/workspaces.go` is already idempotent while provisioning is active, but should be explicit for existing running/recovery workspaces and conflicting duplicate payloads.
- `apps/api/src/routes/node-lifecycle.ts` has a node-ready fallback for undispatched workspaces, but it only runs when a node reports ready and does not preserve the full TaskRunner payload.

## Checklist

- [x] Add `workspace_dispatch` to shared task execution steps and API schema.
- [x] Add TaskRunner dispatch metadata and configurable timeout/backoff.
- [x] Split workspace creation from VM-agent dispatch.
- [x] Route recovered delegated workspaces through dispatch acknowledgement.
- [x] Make `workspace_ready` return to dispatch when `dispatched_at` is missing.
- [x] Tighten VM-agent duplicate `POST /workspaces` handling.
- [x] Update source-contract and focused tests.
- [x] Run targeted validation.

## Acceptance Criteria

- A crash/deploy between D1 workspace creation and VM-agent acknowledgement is recovered by the TaskRunner alarm path.
- `workspace_ready` is not entered for a workspace with `dispatched_at IS NULL`.
- Duplicate VM-agent create requests for the same workspace are idempotent and do not start duplicate provisioning.
- Dispatch failures surface within the configured dispatch timeout instead of waiting for the 30-minute workspace-ready timeout.
