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

1. **Be defined in its own callback route file** under the route family it serves (for example `apps/api/src/routes/projects/agent-activity-callback.ts` for `/api/projects` callbacks or `apps/api/src/routes/deploy-release-callback.ts` for `/api/nodes` callbacks)
2. **Use `extractBearerToken()` + `verifyCallbackToken()`** for authentication — NOT `getUserId()` or `requireAuth()`
3. **Be mounted in `index.ts` BEFORE `projectsRoutes`** at the same `/api/projects` base path
4. **Include a comment** explaining why it's mounted before `projectsRoutes`

## Terminal Callback Classification

A terminal response has the scope of the identity that was rejected. A live node
with no active workspace left in one project should acknowledge that project's
ACP heartbeat without refreshing a session; it must not return a node-terminal
response. Only rejection of the node's own identity can stop node-wide delivery.

Callback JWT routes are not allowed to convert designed terminal callback states into server faults:

1. Expired, malformed, or otherwise unverifiable callback JWTs MUST return a designed auth status such as `401`, not an unhandled `500`. Keep callback signing-key import, JWKS, or storage failures as genuine `5xx` auth-system faults.
2. Callback routes targeting deleted, destroyed, stopped, missing, or otherwise tombstoned node/workspace resources MUST return a documented terminal callback response such as `410 Gone` or another VM-agent-terminal status (`401`/`403`/`404`/`410`) before mutating liveness or accepting writes.
3. Designed callback `4xx`/`410` responses MUST use non-error or bounded low-severity logging. They MUST NOT emit an error-level log or persisted platform error row for every retry attempt.
4. Tests for callback-route changes MUST include the discriminating control: a live node/workspace callback still succeeds through the combined app/router wiring.

## Every Credential Sink Checks the Workspace Lifecycle

Callback JWTs and workspace MCP tokens have no revocation list. A stopped, sleeping or deleted
workspace's credential stays cryptographically valid until it expires, so every sink must re-read
the lifecycle in D1. On 2026-11-08 the AI proxy (`verifyAIProxyAuth`) and every MCP entry point
were found accepting credentials for inactive workspaces, while the `/api/workspaces` callbacks
were fenced correctly.

1. A sink that returns secrets, spends credentials, or mutates state requires an active workspace
   on a live node: `assertWorkspaceAcceptsCallback` / `assertWorkspaceCallbackResourceById` for
   callback tokens, `validateActiveWorkspaceMcpToken` for MCP tokens. Re-check the incarnation
   (`assertWorkspaceCallbackIdentityCurrent`) before a secret leaves.
2. `verifyCallbackToken` rejects tokens with no `scope` or `iat`. Do not add `scope === undefined`
   branches. Still check `payload.scope` after verifying, because tests and future refactors can
   bypass `expectedScope`.
3. Test the sink with a real SQL engine: the same token is accepted while the workspace is active
   and refused after it stops, with one case per refused workspace and node state.
4. A lifecycle check alone does not retire a credential when the same workspace ID runs again.
   On 2026-11-08 a VM restart kept its callback token and an Instant wake left the previous
   container's tokens valid, because both were checked only against the workspace's status. Every
   credential minted for a runtime carries the row's `callback_generation` (`cgen` claim, MCP
   `callbackGeneration`); the reactivating write rotates it; `verifyCallbackToken` and
   `validateActiveWorkspaceMcpToken` refuse a retired generation. When you add a path that starts a
   new runtime for an existing workspace or node, rotate the generation in that write and mint the
   runtime's credentials from it, and make sure no process of the old runtime keeps running (a VM
   rebuild reuses the devcontainer, so the agent stops the old agent processes). When you add a path that renews or delivers to an existing
   runtime, carry the generation it verified or bound, never a fresh read. Never verify a callback
   JWT outside `verifyCallbackToken` (`tests/unit/services/callback-credential-generation.test.ts`
   enforces this). VM node rows are deliberately not rotated: their token stays with the host's VM
   agent, outside devcontainers. A path that exposes a VM node token to workspace processes, or
   reuses a VM node ID for a new runtime, must start rotating `nodes.callback_generation`.

### How to Identify VM Agent Callback Routes

A route is a VM agent callback if ANY of these are true:

- The VM agent Go code constructs a URL for it (grep `packages/vm-agent/` for the URL path)
- The route's JSDoc says "VM agent reports..." or "VM agent calls..."
- The route expects `Authorization: Bearer <callbackToken>` (not a session cookie)
- The route has a `nodeId` field used for identity verification instead of `getUserId()`

### Current Extracted Routes (Reference)

| File                                       | Route                                                                                                                                                                  | Caller                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `agent-activity-callback.ts`               | `POST /:id/acp-sessions/:sessionId/activity`                                                                                                                           | `session_host_reporting.go:reportActivity()` |
| `node-acp-heartbeat.ts`                    | `POST /:id/node-acp-heartbeat`                                                                                                                                         | VM agent heartbeat loop                      |
| `deployment-identity-token.ts`             | `POST /:id/deployment-identity-token`                                                                                                                                  | VM agent deployment identity flow            |
| `registry-push-credentials-callback.ts`    | `POST /:id/registry-push-credentials`                                                                                                                                  | VM agent registry push flow                  |
| `compose-image-artifacts-callback.ts`      | `POST /:id/compose-image-artifacts`                                                                                                                                    | VM agent compose artifact reporting          |
| `compose-publish-release-callback.ts`      | `POST /:id/compose-publish-release`                                                                                                                                    | VM agent compose release reporting           |
| `deployment-publish-job-callback.ts`       | `POST /:id/deployment-publish-jobs/:jobId/*`                                                                                                                           | VM agent deployment publish reporting        |
| `../tasks/callback.ts`                     | `POST /:projectId/tasks/:taskId/status/callback`                                                                                                                       | `server.go:notifyTaskCallback()`             |
| `../node-lifecycle.ts`                     | `POST /api/nodes/:id/ready`, `POST /api/nodes/:id/heartbeat`, `POST /api/nodes/:id/origin-ca-certificate`, `POST /api/nodes/:id/errors`, diagnostic artifact callbacks | VM agent node lifecycle/error reporting      |
| `../deploy-release-callback.ts`            | `POST /api/nodes/:id/deploy-release`, `POST /api/nodes/:id/deploy-routes`                                                                                              | VM agent deployment release fetch            |
| `../deployment-release-events-callback.ts` | `POST /api/nodes/:id/deployment-release-events`                                                                                                                        | `deploy/events.go:reportApplyEvent()`        |

### Mounting Order in `index.ts`

```typescript
// Callback JWT routes — MUST be before projectsRoutes
app.route('/api/projects', deploymentIdentityTokenRoute);
app.route('/api/projects', nodeAcpHeartbeatRoute);
app.route('/api/projects', agentActivityCallbackRoute);
app.route('/api/projects', taskCallbackRoute);
app.route('/api/projects', registryPushCredentialsCallbackRoute);
app.route('/api/projects', composeImageArtifactsCallbackRoute);
app.route('/api/projects', composePublishReleaseCallbackRoute);
app.route('/api/projects', deploymentPublishJobCallbackRoute);
// Session cookie routes
app.route('/api/projects', projectsRoutes);
```

For `/api/nodes` callback routes, use the same ordering rule when the callback
router contains only callback-auth routes:

```typescript
// Callback JWT routes — MUST be before session-auth node routes
app.route('/api/nodes', deployReleaseCallbackRoute);
app.route('/api/nodes', deploymentReleaseEventsCallbackRoute);
// Session cookie routes
app.route('/api/nodes', nodesRoutes);
```

`nodeLifecycleRoutes` is the current mixed-auth exception: it contains callback
routes plus `POST /api/nodes/:id/token`, which relies on `nodesRoutes` session
auth. The existing `nodesRoutes` middleware therefore has an explicit skip for
known lifecycle callback paths. Do not add new callback endpoints by extending a
session-auth wildcard allowlist. Extract new callback-only routes instead;
allowlists are fragile and have repeatedly missed new VM-agent callback paths.

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
- [ ] If VM agent: expired callback tokens and tombstoned callback resources return designed terminal statuses, not `500`
- [ ] If VM agent: terminal callback responses are logged below error severity and covered by live-resource regression controls
