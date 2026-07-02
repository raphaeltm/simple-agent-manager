# VM Agent Callback Routes Must Use Callback JWT Auth (ABSOLUTE RULE)

## The Problem

`projectsRoutes` applies `requireAuth()` + `requireApproved()` middleware via `use('/*', ...)`. This middleware validates **BetterAuth session cookies** — it does NOT recognize callback JWT Bearer tokens. When a VM agent route is placed inside `projectsRoutes` (or any subrouter mounted under it), every VM agent request gets a silent 401 because the VM agent authenticates with a callback JWT, not a session cookie.

This is the Hono middleware scoping leak described in `.claude/rules/06-technical-patterns.md`, applied specifically to VM agent → API callbacks.

## Incident History

This exact class of bug has caused production failures **five times**:

1. **2026-03-12**: Workspace callback routes leaked into session auth middleware (post-mortem exists)
2. **2026-03-25**: Deployment identity token route leaked (post-mortem exists)
3. **2026-05-12**: Task callback route leaked (post-mortem exists)
4. **2026-05-14**: Agent activity route — `reportActivity()` from the VM agent silently failed with 401 for every prompt cycle since the feature was introduced in PR #1002. The "Agent is working..." indicator in the UI never showed the real-time signal; it fell back to a 30-second message-based heuristic.
5. **2026-06-25**: Deployment release apply event route was left under the `/api/nodes` session-auth wildcard. VM agent apply-event callbacks used node callback JWTs and returned 401, leaving the deployment release event timeline empty.

## Hard Rule: VM Agent HTTP Callbacks NEVER Go Inside `projectsRoutes`

Any route that is called by the VM agent over HTTP with a callback JWT Bearer token MUST:

1. **Be defined in its own file** under `apps/api/src/routes/projects/` (e.g., `agent-activity-callback.ts`, `node-acp-heartbeat.ts`)
2. **Use `extractBearerToken()` + `verifyCallbackToken()`** for authentication — NOT `getUserId()` or `requireAuth()`
3. **Be mounted in `index.ts` BEFORE `projectsRoutes`** at the same `/api/projects` base path
4. **Include a comment** explaining why it's mounted before `projectsRoutes`

### How to Identify VM Agent Callback Routes

A route is a VM agent callback if ANY of these are true:

- The VM agent Go code constructs a URL for it (grep `packages/vm-agent/` for the URL path)
- The route's JSDoc says "VM agent reports..." or "VM agent calls..."
- The route expects `Authorization: Bearer <callbackToken>` (not a session cookie)
- The route has a `nodeId` field used for identity verification instead of `getUserId()`

### Current Extracted Routes (Reference)

| File | Route | Caller |
|------|-------|--------|
| `agent-activity-callback.ts` | `POST /:id/acp-sessions/:sessionId/activity` | `session_host_reporting.go:reportActivity()` |
| `node-acp-heartbeat.ts` | `POST /:id/node-acp-heartbeat` | VM agent heartbeat loop |
| `../tasks/callback.ts` | `POST /:projectId/tasks/:taskId/status/callback` | `server.go:notifyTaskCallback()` |
| `../deployment-release-events-callback.ts` | `POST /api/nodes/:id/deployment-release-events` | `deploy/events.go:reportApplyEvent()` |

### Mounting Order in `index.ts`

```typescript
// Callback JWT routes — MUST be before projectsRoutes
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', agentActivityCallbackRoute);
app.route('/api/projects', taskCallbackRoute);
// Session cookie routes
app.route('/api/projects', projectsRoutes);
```

For `/api/nodes` callback routes, use the same ordering rule:

```typescript
// Callback JWT routes — MUST be before session-auth node routes
app.route('/api/nodes', deployReleaseCallbackRoute);
app.route('/api/nodes', deploymentReleaseEventsCallbackRoute);
// Session cookie routes
app.route('/api/nodes', nodesRoutes);
```

Do not add new callback endpoints by extending a session-auth wildcard allowlist. Extract the route instead; allowlists are fragile and have repeatedly missed new VM-agent callback paths.

## How to Detect This Bug

When adding a new route to `acpSessionRoutes` or any subrouter under `projectsRoutes`:

1. **Ask: "Who calls this route?"** If the answer includes the VM agent, it CANNOT be inside `projectsRoutes`.
2. **Check the auth mechanism.** If the route uses `getUserId(c)`, it requires a BetterAuth session cookie. The VM agent does not have one.
3. **Test with `curl` using a Bearer token.** If the route returns 401, the middleware is leaking.

## Quick Compliance Check

Before adding any new route under `/api/projects`:
- [ ] Identified who calls this route (browser, VM agent, internal DO, or cron)
- [ ] If VM agent: route is in its own file with callback JWT auth
- [ ] If VM agent: route is mounted before `projectsRoutes` in `index.ts`
- [ ] If VM agent: route does NOT use `getUserId()`, `requireAuth()`, or `requireApproved()`
- [ ] If VM agent: route uses `extractBearerToken()` + `verifyCallbackToken()`
