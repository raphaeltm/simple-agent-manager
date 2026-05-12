# Post-Mortem: Task Callback 401s from Hono Middleware Scope Leak

**Date**: 2026-05-12
**Severity**: Critical — ALL task callbacks fail immediately (not a TTL issue)
**Duration**: Unknown start (at least since commit `5dd90d50` on 2026-05-10 which fixed internal leaks but not this external one)

## What Broke

VM agents could not report task status (completion, failure, execution step updates) back to the control plane. Every `POST /api/projects/:projectId/tasks/:taskId/status/callback` request returned `401 "Authentication required"` — the default error message from the `requireAuth()` session auth middleware, not from the callback's own `verifyCallbackToken` JWT auth.

This caused agents to retry status callbacks indefinitely, unable to signal task completion.

## Root Cause

`projectsRoutes.use('/*', requireAuth(), requireApproved())` at `apps/api/src/routes/projects/index.ts:11` applies session auth middleware to **all** routes under `/api/projects/*` via Hono's wildcard middleware. When `tasksRoutes` is mounted at `app.route('/api/projects/:projectId/tasks', tasksRoutes)` AFTER `projectsRoutes` at `app.route('/api/projects', projectsRoutes)`, the wildcard middleware from `projectsRoutes` leaks to `tasksRoutes` because Hono merges routes at the same base path.

The task callback route uses its own Bearer JWT auth (`verifyCallbackToken`), but the leaked `requireAuth()` runs first and rejects the VM agent's request (no session cookie) before the callback's auth logic ever executes.

## Timeline

- **2026-03-12**: First instance of this bug class (workspace callback routes). Post-mortem written, fix applied.
- **2026-03-25**: Second instance (deployment identity token route). Post-mortem written, fix applied.
- **2026-05-10**: Commit `5dd90d50` fixed INTERNAL middleware leaks within task subrouters but NOT the EXTERNAL leak from `projectsRoutes`.
- **2026-05-11**: Debug package from workspace `01KRB1X89HYDR6QTPF4MPYYMF1` captured — shows 401s on task callbacks starting 7 minutes after provisioning.
- **2026-05-12**: Root cause identified and fixed.

## Why It Wasn't Caught

1. **Existing fix was partial**: Commit `5dd90d50` addressed internal leaks within `crudRoutes.use('/*')` but missed the external leak from `projectsRoutes.use('/*')`.
2. **No integration test for task callbacks through combined routes**: The workspace callback auth routing test existed (`workspace-callback-auth-routing.test.ts`) but no equivalent existed for task callbacks.
3. **The bug class was documented but not prevented**: Despite two prior post-mortems documenting the exact same Hono middleware scoping issue, no automated guard prevented new instances.

## Class of Bug

**Hono middleware scope leak** — wildcard `use('/*', ...)` middleware on a subrouter leaks to ALL sibling subrouters mounted at overlapping base paths. This is the fourth documented instance:

1. 2026-03-12: Workspace callback routes
2. 2026-03-25: Deployment identity token route
3. 2026-03-25: Node ACP heartbeat route
4. 2026-05-12: Task callback route (this bug)

## Fix

Extract the task callback route into its own Hono subrouter (`apps/api/src/routes/tasks/callback.ts`) and mount it at `/api/projects` BEFORE `projectsRoutes` in `apps/api/src/index.ts`. This follows the identical pattern used for `deploymentIdentityTokenRoute` and `nodeAcpHeartbeatRoute`.

## Process Fix

1. **Regression test added** (`task-callback-auth-routing.test.ts`): Tests the task callback route through the COMBINED app routes (not individual subrouters) to verify Bearer JWT auth is not blocked by session auth.
2. **Rule `.claude/rules/06-api-patterns.md` already documents this** — the fix follows the documented pattern exactly. The gap was that the task callback route was never extracted despite being in the same bug class.
