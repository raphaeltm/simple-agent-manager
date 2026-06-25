SAM's identity and multi-tenancy boundary is mostly centralized around BetterAuth sessions, `requireAuth`/`requireApproved`, project ownership checks, and callback JWTs. The main route tree generally enforces project ownership before touching `ProjectData` Durable Objects, admin routes are consistently superadmin-gated, callback routes are mounted before session-auth project routes per rule 34, and credential fallback code has explicit inactive-scoped-row halts. The concrete findings below are therefore concentrated in two boundary-hardening gaps: callback JWT subject binding for node/activity callbacks, and a first-user promotion query that still depends on a single sentinel id instead of the required `status != 'system'` discriminator.

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 0 |
| Medium | 2 |
| Low | 2 |
| Info | 1 |

## Findings

### AUTH-001: ACP callback routes accept valid callback JWTs without binding token identity to the reported node

Severity: Medium

CWE: CWE-639 (Authorization Bypass Through User-Controlled Key), CWE-863 (Incorrect Authorization)

Location: `apps/api/src/routes/projects/agent-activity-callback.ts:35`, `apps/api/src/routes/projects/agent-activity-callback.ts:37`, `apps/api/src/routes/projects/agent-activity-callback.ts:50`, `apps/api/src/routes/projects/agent-activity-callback.ts:54`, `apps/api/src/routes/projects/node-acp-heartbeat.ts:29`, `apps/api/src/routes/projects/node-acp-heartbeat.ts:36`, `apps/api/src/routes/projects/node-acp-heartbeat.ts:47`, `apps/api/src/routes/projects/node-acp-heartbeat.ts:55`

Description: `agent-activity-callback` and `node-acp-heartbeat` verify that the caller has a valid SAM callback JWT, but they do not require the token subject (`payload.workspace`, which is a workspace id for workspace-scoped tokens and a node id for node-scoped tokens) to match the node or workspace being reported. `agent-activity-callback` accepts both workspace and node scoped tokens, then authorizes solely by comparing the request body `nodeId` to the ACP session's stored `nodeId`. `node-acp-heartbeat` accepts both scopes and explicitly skips cross-checking the JWT identity against `projectId` or `body.nodeId`.

Impact/Exploit scenario: A compromised VM agent or leaked callback JWT for one workspace/node can submit activity or heartbeat updates for another node if it can guess or learn `projectId`, `sessionId`, and `nodeId`. This is an integrity IDOR: the attacker can forge "agent is working", status error, restart count, and heartbeat signals for sessions it does not own. I did not find a direct credential disclosure path from these two routes, so this is Medium rather than High.

Evidence:

```ts
// apps/api/src/routes/projects/agent-activity-callback.ts:35-42
const payload = await verifyCallbackToken(token, c.env);

if (payload.scope !== 'workspace' && payload.scope !== 'node') {
  log.error('acp_activity.invalid_token_scope', {
    scope: payload.scope,
    action: 'rejected',
  });
  throw errors.forbidden('Invalid token scope for activity report');
}
```

```ts
// apps/api/src/routes/projects/agent-activity-callback.ts:50-65
const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
if (!existing) {
  throw errors.notFound('ACP session not found');
}
if (existing.nodeId !== body.nodeId) {
  ...
  throw errors.forbidden('Node identity verification failed');
}

await projectDataService.reportAcpSessionActivity(c.env, projectId, sessionId, body.activity, {
```

```ts
// apps/api/src/routes/projects/node-acp-heartbeat.ts:47-55
// Note: We intentionally do NOT cross-check payload.workspace against projectId
// here. The VM agent iterates over its active projects and sends one heartbeat
// per project, all using the same callback token. The DO's updateNodeHeartbeats
// only touches sessions assigned to the given nodeId, limiting blast radius.
// This matches the existing backup sweep pattern in nodes.ts:655-663.
// A D1 lookup per heartbeat would defeat the lightweight 2-hop design.
let updated: number;
try {
  updated = await projectDataService.updateNodeHeartbeats(c.env, projectId, body.nodeId);
```

Remediation: Bind callback tokens to the identity they are allowed to report. For node-scoped tokens, require `payload.workspace === body.nodeId` before updating node/session state. For workspace-scoped tokens, resolve the token workspace and verify it belongs to the route `projectId` and to the ACP session being updated, or reject workspace-scoped tokens on node-level heartbeat routes. If multi-project node heartbeat batching is still required, mint a node-scoped token and use the node id as the sole accepted identity.

Confidence: Confirmed

### AUTH-002: First-user superadmin create hook excludes only one sentinel id, not all `status='system'` rows

Severity: Medium

CWE: CWE-266 (Incorrect Privilege Assignment)

Location: `apps/api/src/auth.ts:259`, `apps/api/src/auth.ts:261`, `apps/api/src/auth.ts:264`

Description: Rule 40 requires business-logic counts/existence checks over sentinel-bearing tables to exclude `status = 'system'` in the `WHERE` clause. The login-time self-heal query does this correctly, but the `user.create.before` hook still decides first-user superadmin status by excluding only the configured anonymous-trials sentinel id. If another internal/system user row exists with a different id, the first real human is treated as a subsequent user and becomes `pending`.

Impact/Exploit scenario: A fresh or forked deployment containing any non-trial system row can lock the first real operator out of superadmin/admin surfaces. The current login-time self-heal reduces impact after session creation, but the create path still violates the durable rule and can reintroduce the original lockout class as soon as another sentinel row is added.

Evidence:

```ts
// apps/api/src/auth.ts:259-266
// Check if this is the first user (auto-superadmin)
const hookDb = drizzle(env.DATABASE, { schema });
const existing = await hookDb
  .select({ id: schema.users.id })
  .from(schema.users)
  .where(ne(schema.users.id, sentinelId))
  .limit(1)
  .all();
```

```ts
// apps/api/src/auth.ts:41-51 (self-heal gets this right)
AND (
  SELECT COUNT(*) FROM users u2
  WHERE u2.id != ?1
    AND u2.status != 'system'
    AND u2.id != ?2
) = 0
AND (
  SELECT COUNT(*) FROM users u3
  WHERE u3.role = 'superadmin'
    AND u3.status != 'system'
) = 0
```

Remediation: Change the create hook query to exclude all system rows at the source, for example `where(ne(schema.users.status, 'system'))`, with the existing sentinel-id exclusion only as an optional extra defense. Add a regression test where at least two `status='system'` rows exist before the first real user signs in.

Confidence: Confirmed

### AUTH-003: `/api/auth/token-login` returns the signed session cookie value in the JSON response body

Severity: Low

CWE: CWE-200 (Exposure of Sensitive Information to an Unauthorized Actor)

Location: `apps/api/src/services/session-factory.ts:61`, `apps/api/src/services/session-factory.ts:88`, `apps/api/src/services/session-factory.ts:93`, `apps/api/src/routes/api-tokens.ts:187`

Description: Token-login correctly sets an HttpOnly session cookie, but it also returns `sessionCookie` in the JSON body. That makes the signed BetterAuth session token visible to JavaScript, logs, browser devtools copy flows, and any client-side instrumentation that records response bodies. This undercuts the value of `HttpOnly` for this login path.

Impact/Exploit scenario: If a browser-facing caller uses token-login, any script or logging layer that can read the response body can exfiltrate a fresh session cookie. The attacker still needs access to a valid API/smoke token or to the login response, so this is Low rather than a primary authentication bypass.

Evidence:

```ts
// apps/api/src/services/session-factory.ts:88-100
const { cookieHeader, sessionCookie } = await createSessionCookieForUser(env, user.id);
return new Response(
  JSON.stringify({
    success: true,
    user: { id: user.id, email: user.email, name: user.name },
    sessionCookie,
  }),
  {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': cookieHeader,
    },
```

```ts
// apps/api/src/routes/api-tokens.ts:187
return buildSessionLoginResponse(c.env, user);
```

Remediation: Return only non-secret metadata in the JSON body, such as `{ success: true, user: ... }`. Keep the signed session token exclusively in the `Set-Cookie` header. If tests need the raw cookie, gate a test-only response field behind an explicit non-production environment flag and never enable it for production.

Confidence: Confirmed

### AUTH-004: Workspace access tokens are accepted and propagated in URLs

Severity: Low

CWE: CWE-598 (Use of GET Request Method With Sensitive Query Strings)

Location: `apps/api/src/index.ts:245`, `apps/api/src/index.ts:247`, `apps/api/src/index.ts:331`, `apps/api/src/index.ts:425`, `apps/api/src/index.ts:426`, `apps/api/src/routes/codex-refresh.ts:47`, `apps/api/src/routes/workspaces/crud.ts:100`

Description: Several bearer-equivalent workspace tokens are intentionally carried in query parameters: `port_token` for exposed ports, `token` for workspace terminal proxying, and `token` for `/api/auth/codex-refresh`. The port-token path strips the user-facing URL after validation, but the token still appears in the initial URL. The worker also injects a fresh terminal JWT into the proxied VM-agent URL with `vmUrl.searchParams.set('token', token)`.

Impact/Exploit scenario: Query tokens can leak through browser history, copied URLs, upstream logs, reverse-proxy logs, or referrers from a proxied service before the redirect strips them. The default lifetimes are bounded (`PORT_ACCESS_TOKEN_EXPIRY_MS` defaults to 15 minutes and terminal token expiry defaults to 1 hour), and comments indicate some clients cannot set headers, so this is Low and partly accepted design debt rather than an immediate bypass.

Evidence:

```ts
// apps/api/src/index.ts:245-258
// 5b: Check ?port_token= query param (initial request from expose_port URL)
if (!userId) {
  const portToken = url.searchParams.get('port_token');
  if (portToken) {
    try {
      const payload = await verifyPortAccessToken(portToken, c.env);
      if (payload.workspace === workspaceId && payload.port === targetPort) {
        // Set cookie and 302 redirect to strip token from URL
        const cookieMaxAge = c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS
          ? parseInt(c.env.PORT_ACCESS_COOKIE_MAX_AGE_SECONDS, 10)
          : 14400;
        const redirectUrl = new URL(url.toString());
        redirectUrl.searchParams.delete('port_token');
```

```ts
// apps/api/src/index.ts:331-337
const token = url.searchParams.get('token');
if (!token) {
  return c.json({ error: 'UNAUTHORIZED', message: 'Authentication required' }, 401);
}

try {
  const payload = await verifyTerminalToken(token, c.env);
```

```ts
// apps/api/src/index.ts:425-426
const { token } = await signTerminalToken('port-proxy', workspaceId, c.env);
vmUrl.searchParams.set('token', token);
```

```ts
// apps/api/src/routes/codex-refresh.ts:46-49
// Auth: extract callback token from query param (Codex can't set headers).
const token = c.req.query('token');
if (!token) {
  return c.json({ error: 'invalid_request', message: 'Missing token query parameter' }, 401);
}
```

Remediation: Prefer `Authorization: Bearer` headers for server-to-server calls and WebSocket subprotocol/header alternatives where clients support them. For URL-only clients, keep one-time-use semantics, shortest feasible TTLs, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and immediate redirect stripping. Avoid injecting fresh proxy JWTs into upstream URLs when an `Authorization` header can be used.

Confidence: Confirmed

### AUTH-005: Verified non-findings and subagent synthesis status

Severity: Info

CWE: N/A

Location: `apps/api/src/index.ts:608`, `apps/api/src/index.ts:614`, `apps/api/src/index.ts:622`, `apps/api/src/middleware/project-auth.ts:35`, `apps/api/src/middleware/project-auth.ts:41`, `apps/api/src/middleware/auth.ts:171`, `apps/api/src/routes/admin.ts:19`, `apps/api/src/routes/credentials.ts:1016`, `apps/api/src/routes/credentials.ts:1033`, `apps/api/src/routes/credentials.ts:1039`

Description: Several high-risk areas were explicitly checked and did not produce findings in this pass. Rule 34 callback routes are mounted before `projectsRoutes`; `requireOwnedProject`, `requireOwnedTask`, and `requireOwnedWorkspace` include query filters plus post-query ownership checks; admin routes reviewed under `/api/admin/*` use `requireAuth`, `requireApproved`, and `requireSuperadmin`; the legacy credential resolver has an inactive project-scoped credential halt instead of falling through to user-level credentials.

Impact/Exploit scenario: N/A. This is included to make the negative coverage auditable.

Evidence:

```ts
// apps/api/src/index.ts:608-622
// ORDERING IS CRITICAL: Routes using callback JWT auth MUST be mounted before
// projectsRoutes. projectsRoutes has use('/*', requireAuth()) which leaks to
// all siblings at the same base path ...
app.route('/api/projects', deploymentIdentityTokenRoute);
...
app.route('/api/projects', deploymentPublishJobCallbackRoute);
app.route('/api/projects', projectsRoutes);
```

```ts
// apps/api/src/middleware/project-auth.ts:35-41
const rows = await db
  .select()
  .from(schema.projects)
  .where(and(eq(schema.projects.id, projectId), eq(schema.projects.userId, userId)))
  .limit(1);

return assertOwnership(rows[0], userId, 'Project');
```

```ts
// apps/api/src/routes/admin.ts:18-19
// All admin routes require auth + approval + superadmin
adminRoutes.use('/*', requireAuth(), requireApproved(), requireSuperadmin());
```

```ts
// apps/api/src/routes/credentials.ts:1016-1039
// 1. Project-scoped credential (Rule 28: inactive blocks fallthrough)
if (projectId) {
  ...
  if (projectCred) {
    if (projectCred.isActive) {
      return {
        key: await decrypt(projectCred.encryptedValue, projectCred.iv, encryptionKey),
        credentialSource: 'project',
      };
    }
    return null;
  }
}
```

Remediation: Preserve these patterns. Add behavior tests that return mismatched rows from DB stubs to prove the post-query ownership assertions fire; avoid source-contract-only IDOR tests.

Confidence: Confirmed

## Subagent Status

Three SAM subtasks were dispatched with profile `01KSWW2DQTZ8N3F2PYXKMJ7QZZ` and mission `c879abb0-770a-4187-8503-77dc1ba42ca8`.

| Subtask | Scope | Status at synthesis | Summary used |
| --- | --- | --- | --- |
| `01KVZ8N26JJAB1BRQEE13YFK35` | Route-by-route IDOR sweep | In progress | No completion summary available before report write |
| `01KVZ8NEQNJWDXDGWS59VQD7GX` | Auth/JWT/session crypto | Failed: Hetzner server limit reached | None |
| `01KVZ8NV5AKGZWDEM9S9CZ1S8D` | Admin/superadmin authorization | Failed: Hetzner server limit reached | None |

