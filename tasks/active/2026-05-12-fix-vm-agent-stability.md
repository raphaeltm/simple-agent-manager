# Fix VM Agent Stability: Unattended-Upgrades, Duplicate Workspace, Auth Failures, MCP TTL

## Problem

Debug package analysis revealed four interconnected production issues that cause agents to go offline or lose functionality:

1. **Ubuntu unattended-upgrades kills the VM agent** — `apt-daily-upgrade.timer` triggers `unattended-upgrades` which causes a systemd daemon-reexec. This cascades into restarting the vm-agent service, killing all active agent sessions. Observed at 06:32:50 UTC on 2026-05-12.

2. **Duplicate workspace creation race condition** — When the VM agent sends the node-ready callback (`POST /nodes/:id/ready`), the handler dispatches all 'creating' workspaces. But the TaskRunner DO has already dispatched the same workspace — its devcontainer build is just still running. Result: two parallel devcontainer builds, git credential collisions.

3. **Task callback 401 auth failures** — `projectsRoutes.use('/*', requireAuth())` leaks session auth middleware to the task status callback route. The VM agent's Bearer JWT is rejected with 401 before the callback route's own `verifyCallbackToken` runs.

4. **MCP token 4h TTL expires during long tasks** — MCP tokens have a fixed 4-hour TTL with no sliding window. Agents running longer than 4h lose MCP tool access.

## Research Findings

### Fix 1: Unattended-upgrades
- Cloud-init already sets `package_update: false` and `package_upgrade: false` in `packages/cloud-init/src/template.ts:14-17`
- But `unattended-upgrades` is a separate systemd timer pre-installed on Ubuntu, not controlled by cloud-init package settings
- The VM agent runs as a systemd service; daemon-reexec restarts it
- VMs are ephemeral — auto-upgrades provide no security benefit and destroy running work
- Fix: disable `apt-daily-upgrade.timer`, `apt-daily.timer`, and `unattended-upgrades.service` in runcmd

### Fix 2: Duplicate workspace creation
- `node-lifecycle.ts:57-118` — ready handler queries D1 for `status = 'creating'` workspaces, calls `createWorkspaceOnNode()` for each
- `workspace-steps.ts:115-169` — TaskRunner's `createAndProvisionWorkspace()` inserts workspace with `status = 'creating'`, then calls `createWorkspaceOnVmAgent()` immediately
- Race window: TaskRunner inserts workspace → TaskRunner calls VM agent → VM agent finishes boot provisioning → ready callback fires → ready handler finds 'creating' workspace → dispatches duplicate
- Ready handler IS a legitimate safety net for the crash recovery window (workspace inserted in D1 but DO crashed before calling VM agent)
- Fix: Add `dispatched_to_agent_at TEXT` column via migration. Set it before calling VM agent in both paths. Ready handler filters `WHERE dispatched_to_agent_at IS NULL`.

### Fix 3: Task callback 401
- `apps/api/src/routes/projects/index.ts:11` — `projectsRoutes.use('/*', requireAuth(), requireApproved())`
- `apps/api/src/routes/tasks/crud.ts:452` — callback route uses `verifyCallbackToken()` (Bearer JWT), not session auth
- `apps/api/src/index.ts:530-531` — `projectsRoutes` mounted at `/api/projects` BEFORE `tasksRoutes` at `/api/projects/:projectId/tasks`
- Known Hono bug class — same pattern as deployment-identity-token fix and node-acp-heartbeat fix
- Fix: Extract callback route into separate Hono instance, mount before `projectsRoutes` in `index.ts`
- Pattern to follow: `apps/api/src/routes/projects/node-acp-heartbeat.ts` and `apps/api/src/routes/project-deployment.ts` (deploymentIdentityTokenRoute)

### Fix 4: MCP token sliding window
- `packages/shared/src/constants/defaults.ts:108` — `DEFAULT_MCP_TOKEN_TTL_SECONDS = 14400` (4h)
- `apps/api/src/services/mcp-token.ts` — simple KV get/put, no sliding window
- Call sites: `mcp/_helpers.ts:285`, `project-deployment.ts:336`
- KV supports `expirationTtl` on `put()` — re-putting with new TTL extends expiration
- Fix: On each `validateMcpToken()` call, re-put with fresh TTL (throttled to avoid excessive KV writes). Add max lifetime cap.

## Implementation Checklist

### Fix 1: Disable unattended-upgrades in cloud-init

- [ ] Add runcmd commands to `packages/cloud-init/src/template.ts` to disable apt timers and unattended-upgrades
- [ ] Add test verifying the generated cloud-init output contains the disable commands

### Fix 2: Deduplicate workspace creation

- [ ] Add migration `0049_workspace_dispatched_to_agent.sql`: `ALTER TABLE workspaces ADD COLUMN dispatched_to_agent_at TEXT;`
- [ ] Add `dispatchedToAgentAt` to workspace schema in `apps/api/src/db/schema.ts`
- [ ] In `workspace-steps.ts:createWorkspaceOnVmAgent()`, set `dispatched_to_agent_at = NOW` before calling VM agent
- [ ] In `node-lifecycle.ts:57-118` ready handler, filter pending workspaces by `AND dispatched_to_agent_at IS NULL`
- [ ] In `node-lifecycle.ts` ready handler, also set `dispatched_to_agent_at` before calling `createWorkspaceOnNode()`
- [ ] Write integration test proving ready handler skips already-dispatched workspaces

### Fix 3: Extract task callback route

- [ ] Create `apps/api/src/routes/tasks/callback.ts` with separate Hono instance containing only the `POST /:projectId/tasks/:taskId/status/callback` route
- [ ] Remove the callback route from `apps/api/src/routes/tasks/crud.ts`
- [ ] Export `taskCallbackRoute` from `apps/api/src/routes/tasks/index.ts`
- [ ] Mount `taskCallbackRoute` at `/api/projects` BEFORE `projectsRoutes` in `apps/api/src/index.ts`
- [ ] Write integration test through combined app routes proving callback accepts Bearer JWT

### Fix 4: MCP token sliding window + 8h TTL

- [ ] Update `DEFAULT_MCP_TOKEN_TTL_SECONDS` from 14400 to 28800 (8h) in `packages/shared/src/constants/defaults.ts`
- [ ] Add `MCP_TOKEN_MAX_LIFETIME_SECONDS` env var to `apps/api/src/env.ts` (default 86400 = 24h)
- [ ] Add `lastRefreshedAt` optional field to `McpTokenData` in `mcp-token.ts`
- [ ] Add `getMcpTokenMaxLifetime()` helper in `mcp-token.ts`
- [ ] Implement sliding window in `validateMcpToken()`: on each use, check if >50% of TTL elapsed since last refresh; if so, re-put with fresh TTL. Cap by max lifetime.
- [ ] Update `validateMcpToken` signature to accept env parameter
- [ ] Update call sites: `mcp/_helpers.ts:285`, `project-deployment.ts:336`
- [ ] Write unit tests for sliding window: throttle, max lifetime, expired token

### Documentation & Process

- [ ] Write post-mortem: `docs/notes/2026-05-12-unattended-upgrades-vm-agent-kill-postmortem.md`
- [ ] Update `.env.example` with `MCP_TOKEN_MAX_LIFETIME_SECONDS`

## Acceptance Criteria

- [ ] Cloud-init disables unattended-upgrades and apt-daily timers
- [ ] Ready handler does not dispatch workspaces already dispatched to VM agent
- [ ] Task callback endpoint accepts Bearer JWT without 401 when tested through combined app routes
- [ ] MCP tokens auto-extend TTL while in active use (sliding window)
- [ ] MCP tokens expire after 8h of inactivity (default TTL)
- [ ] MCP tokens are rejected after 24h regardless of activity (max lifetime)
- [ ] KV writes throttled: only refresh when >50% of TTL elapsed
- [ ] All existing tests pass
- [ ] No hardcoded values — all configurable via env vars

## References

- Debug package analysis: `/workspaces/.private/debug-01KRDBGEED1ZS1E8YQSN694P1Q.tar.gz`
- Previous session: 70b24ab9-1503-443d-a4ba-7e5b4720c14a
- `tasks/backlog/2026-05-12-fix-agent-auth-failures.md` (superseded by this task)
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md`
- `.claude/rules/06-api-patterns.md` (Hono middleware scoping)
- `.claude/rules/31-migration-safety.md`
