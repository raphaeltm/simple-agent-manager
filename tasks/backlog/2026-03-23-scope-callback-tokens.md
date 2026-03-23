# Scope Node-Level Callback Tokens to Prevent Cross-Workspace Secret Access

## Problem

The node callback token (issued during cloud-init via `signCallbackToken(node.id, env)` in `apps/api/src/services/nodes.ts:116`) grants access to ALL workspace secrets on that node.

In `verifyWorkspaceCallbackAuth()` (`apps/api/src/routes/workspaces/_helpers.ts:94-126`), the second check at line 121 allows any token whose `workspace` claim matches the workspace's `nodeId` to pass. This means the shared node-level callback token (available to any process on the VM via the `CALLBACK_TOKEN` env var) can call `/agent-key`, `/runtime-assets`, `/agent-settings`, `/agent-credential-sync`, etc. for ANY co-tenant workspace, leaking Anthropic API keys and other secrets.

## Research Findings

### Token Flow

1. **Node provisioning** (`services/nodes.ts:116`): `signCallbackToken(node.id, env)` creates token with `workspace: nodeId` — embedded in cloud-init as `CALLBACK_TOKEN` env var
2. **Workspace creation** (`_helpers.ts:233`): `signCallbackToken(workspaceId, env)` creates token with `workspace: workspaceId` — sent to VM agent per-workspace
3. **Node heartbeat refresh** (`nodes.ts:611`): `signCallbackToken(nodeId, c.env)` refreshes the node-level token
4. **VM agent fallback** (`workspace_provisioning.go:27-35`): `callbackTokenForWorkspace()` uses per-workspace token if available, falls back to node-level `CALLBACK_TOKEN`

### Affected Endpoints (workspace-scoped, sensitive)

All use `verifyWorkspaceCallbackAuth()`:
- `POST /:id/agent-key` — returns decrypted API keys
- `POST /:id/agent-credential-sync` — writes credentials
- `POST /:id/agent-settings` — returns agent settings
- `GET /:id/runtime` — returns workspace metadata
- `GET /:id/runtime-assets` — returns decrypted env vars and files
- `POST /:id/git-token` — returns GitHub installation token
- `POST /:id/boot-log` — appends boot logs
- `POST /:id/messages` — persists chat messages
- `POST /:id/ready` — marks workspace ready (lifecycle)
- `POST /:id/provisioning-failed` — marks workspace failed (lifecycle)

### Node-scoped endpoints (use `verifyNodeCallbackAuth`)

All in `apps/api/src/routes/nodes.ts`:
- `POST /:id/ready` — marks node ready
- `POST /:id/heartbeat` — node heartbeat
- `POST /:id/errors` — error reporting

### Key Design Constraints

- VM agent stores per-workspace tokens in `WorkspaceRuntime.CallbackToken` (`server.go:91`)
- Node-level token is in `config.CallbackToken` (`config.go:57`)
- `callbackTokenForWorkspace()` prefers workspace token, falls back to node token
- Backward compatibility: existing running VMs have tokens without scope claims

## Implementation Checklist

- [ ] 1. Add `scope` claim to `CallbackTokenPayload` interface in `jwt.ts` — optional `'node' | 'workspace'` field
- [ ] 2. Create `signNodeCallbackToken(nodeId, env)` function in `jwt.ts` that adds `scope: 'node'` claim
- [ ] 3. Update `signCallbackToken(workspaceId, env)` to add `scope: 'workspace'` claim
- [ ] 4. Update `verifyCallbackToken()` to extract and return the `scope` claim (optional, for backward compat)
- [ ] 5. Update `verifyWorkspaceCallbackAuth()` to REJECT tokens with `scope: 'node'` — they cannot access workspace-scoped endpoints. Allow legacy tokens (no scope) with deprecation warning.
- [ ] 6. Update `verifyNodeCallbackAuth()` in `nodes.ts` to accept `scope: 'node'` tokens and legacy tokens, but reject `scope: 'workspace'` tokens
- [ ] 7. Update all callers of `signCallbackToken` for node-level tokens to use `signNodeCallbackToken`:
  - `services/nodes.ts:116` (provisionNode)
  - `nodes.ts:611` (heartbeat token refresh)
- [ ] 8. Update `shouldRefreshCallbackToken` to work with both token types (no changes needed — it only reads iat/exp)
- [ ] 9. Write unit tests:
  - Test that `signNodeCallbackToken` produces tokens with `scope: 'node'`
  - Test that `signCallbackToken` produces tokens with `scope: 'workspace'`
  - Test that `verifyWorkspaceCallbackAuth` REJECTS node-scoped tokens for workspace endpoints
  - Test that `verifyWorkspaceCallbackAuth` ACCEPTS workspace-scoped tokens
  - Test that `verifyWorkspaceCallbackAuth` ACCEPTS legacy tokens (no scope) with the existing fallback behavior
  - Test that `verifyNodeCallbackAuth` ACCEPTS node-scoped tokens
  - Test that `verifyNodeCallbackAuth` REJECTS workspace-scoped tokens
- [ ] 10. Write capability test: node-scoped token cannot access `/:id/agent-key` for a co-tenant workspace
- [ ] 11. Update existing tests that mock `verifyCallbackToken` to include `scope` in mock returns

## Acceptance Criteria

- [ ] Node-scoped callback tokens include `scope: 'node'` claim
- [ ] Workspace-scoped callback tokens include `scope: 'workspace'` claim
- [ ] Node-scoped tokens CANNOT access workspace-scoped endpoints (agent-key, runtime-assets, etc.)
- [ ] Workspace-scoped tokens CAN access their own workspace endpoints
- [ ] Legacy tokens (no scope) maintain backward compatibility with deprecation warning
- [ ] All existing tests pass
- [ ] New tests cover the scope enforcement boundary
- [ ] No changes to cloud-init template or VM agent code (tokens are opaque JWTs to the VM agent)
