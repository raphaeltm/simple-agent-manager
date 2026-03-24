# Remove Legacy Node-Level Callback Token Fallback

## Problem

`verifyWorkspaceCallbackAuth()` in `apps/api/src/routes/workspaces/_helpers.ts:136-158` has a legacy fallback that allows a node-scoped callback token to access workspace-scoped endpoints by matching the workspace's `nodeId` field. This is the same class of vulnerability as the callback token identity endpoint issue (fixed in PR for `project-deployment.ts`).

The code has a hard-coded removal deadline of 2026-04-23. Given callback tokens have a 24h TTL, any node provisioned more than 24h ago already has scoped tokens.

## Discovery Context

Found by security-auditor during review of the callback token identity endpoint fix (2026-03-24).

## Acceptance Criteria

- [ ] Monitor `console.warn` log for `'Legacy node-level callback token used for workspace access (deprecated)'` — confirm it's silent
- [ ] Remove legacy fallback path at `_helpers.ts:136-158`
- [ ] All workspace callback auth tests still pass
- [ ] No active nodes are using pre-scope tokens
