# Fix Workspace Dispatch Race With `dispatched_at`

## Problem

TaskRunner-created workspaces are inserted into D1 with `status = 'creating'` and then dispatched to the VM agent. The node-lifecycle ready handler also scans `creating` workspaces for the same node and can send a duplicate `POST /workspaces` to the VM agent.

## Research Findings

- `apps/api/src/durable-objects/task-runner/workspace-steps.ts` inserts a workspace, stores the workspace id on the task, then calls `createWorkspaceOnVmAgent()`.
- `apps/api/src/routes/workspaces/_helpers.ts` has the UI/manual creation path in `scheduleWorkspaceCreateOnNode()`, which sets status to `creating` and calls `createWorkspaceOnNode()`.
- `apps/api/src/routes/node-lifecycle.ts` handles `POST /api/nodes/:id/ready` and replays every workspace where `node_id = ?` and `status = 'creating'`.
- `apps/api/src/db/schema.ts` currently has no dispatch marker on `workspaces`.
- Migration rule allows `ALTER TABLE ADD COLUMN` for nullable columns; this change is safe and avoids table recreation.
- The referenced `docs/notes/2026-05-16-duplicate-workspace-dispatch-env-var-loss-postmortem.md` is not present in this checkout. Related notes present: env var single-quote stripping and workspace restart stale error.
- Existing integration tests often include source-contract tests that read split modules and verify cross-boundary wiring.

## Implementation Checklist

- [ ] Add migration `0049_workspace_dispatched_at.sql` with nullable `dispatched_at`.
- [ ] Add `dispatchedAt` to the Drizzle `workspaces` schema.
- [ ] Set `dispatched_at` after successful TaskRunner VM agent workspace dispatch.
- [ ] Set `dispatched_at` after successful UI/manual workspace dispatch.
- [ ] Filter node-lifecycle ready replay to `creating` workspaces with `dispatched_at IS NULL`.
- [ ] Add integration coverage for ready-handler skip/replay behavior and TaskRunner dispatch marking.
- [ ] Run migration safety and typecheck.

## Acceptance Criteria

- A workspace with non-null `dispatched_at` is not selected for ready-handler redispatch.
- A legacy workspace with null `dispatched_at` remains eligible for ready-handler dispatch.
- TaskRunner records `dispatched_at` only after VM agent workspace creation succeeds.
- UI/manual workspace creation records `dispatched_at` only after VM agent workspace creation succeeds.
- Migration safety passes for the new nullable column migration.

## References

- `apps/api/src/routes/node-lifecycle.ts`
- `apps/api/src/durable-objects/task-runner/workspace-steps.ts`
- `apps/api/src/routes/workspaces/_helpers.ts`
- `apps/api/src/db/schema.ts`
- `.claude/rules/31-migration-safety.md`
