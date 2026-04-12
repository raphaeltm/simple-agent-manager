# Devcontainer Config Name: Secondary Path Gaps

## Problem

PR #680 added `devcontainerConfigName` support through the primary task submission flow, but two secondary workspace creation paths don't forward the field:

1. **Node reconnect path** (`apps/api/src/routes/nodes.ts:493-518`): When a node comes back online and re-dispatches stuck workspaces, it queries D1 but doesn't select `devcontainerConfigName`, so re-dispatched workspaces lose their config name.

2. **Direct workspace creation** (`POST /workspaces`): The `CreateWorkspaceSchema` in `apps/api/src/schemas/workspaces.ts`, the CRUD handler in `apps/api/src/routes/workspaces/crud.ts`, and `scheduleWorkspaceCreateOnNode()` in `_helpers.ts` don't accept or forward the field.

## Context

Discovered by Cloudflare specialist review of PR #680 (post-merge).

## Implementation Checklist

- [ ] `apps/api/src/routes/nodes.ts`: Add `devcontainerConfigName` to the pending workspaces SELECT query and forward to `createWorkspaceOnNode()`
- [ ] `apps/api/src/schemas/workspaces.ts`: Add `devcontainerConfigName` to `CreateWorkspaceSchema`
- [ ] `apps/api/src/routes/workspaces/crud.ts`: Resolve config name (body → project default → null) and include in INSERT
- [ ] `apps/api/src/routes/workspaces/_helpers.ts`: Add `devcontainerConfigName` parameter to `scheduleWorkspaceCreateOnNode()` and forward to `createWorkspaceOnNode()`

## Acceptance Criteria

- [ ] Node reconnect re-dispatches workspaces with their original devcontainer config name
- [ ] Direct workspace creation accepts and persists devcontainer config name
- [ ] Project default devcontainer config is resolved when creating workspaces directly
