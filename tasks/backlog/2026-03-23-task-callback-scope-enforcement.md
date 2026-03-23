# Add scope enforcement to tasks/crud.ts callback endpoint

## Problem

The `POST /:taskId/status/callback` endpoint in `apps/api/src/routes/tasks/crud.ts:406` calls `verifyCallbackToken` directly without checking the `scope` claim. This was missed during the callback token scoping fix (PR #483). While the workspace ID check at line 419 (`payload.workspace !== task.workspaceId`) provides protection since node IDs and workspace IDs don't collide, an explicit scope check is defense-in-depth best practice.

## Context

Discovered by security-auditor agent reviewing PR #483 (scope callback tokens). The other two callsites (`verifyWorkspaceCallbackAuth` and `verifyNodeCallbackAuth`) were updated with explicit scope checks, but this third direct callsite was not.

## Implementation Checklist

- [ ] Add `if (payload.scope === 'node') { throw errors.forbidden('Insufficient token scope'); }` after `verifyCallbackToken` call at `apps/api/src/routes/tasks/crud.ts:406`
- [ ] Remove dead `signCallbackToken` import from `apps/api/src/routes/nodes.ts:14`
- [ ] Add test in `apps/api/tests/unit/` verifying node-scoped tokens are rejected at task callback endpoint
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test`

## Acceptance Criteria

- [ ] Node-scoped tokens are explicitly rejected at the task callback endpoint
- [ ] Test proves the rejection works
- [ ] Dead import cleaned up
