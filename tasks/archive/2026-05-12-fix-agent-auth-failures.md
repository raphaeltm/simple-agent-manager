# Fix Agent Auth Failures: Task Callback 401s + MCP Token Expiration

## Problem

Debug package analysis from workspace `01KRB1X89HYDR6QTPF4MPYYMF1` (2026-05-11) reveals two auth issues that prevent agents from completing their work:

### Issue 1: Task Callback 401s (CRITICAL — Immediate Failure)

`projectsRoutes.use('/*', requireAuth(), requireApproved())` at `apps/api/src/routes/projects/index.ts:11` leaks session auth middleware to the task callback route at `POST /api/projects/:projectId/tasks/:taskId/status/callback`. The leaked `requireAuth()` runs BEFORE the callback route's own `verifyCallbackToken` JWT auth, rejecting the VM agent's Bearer token request with 401 "Authentication required" (no session cookie).

This is the THIRD instance of the Hono middleware scope leak bug class:
- 2026-03-12: workspace callback routes (post-mortem exists)
- 2026-03-25: deployment identity token route (post-mortem exists)
- 2026-05-11: task callback route (this bug)

The fix at commit `5dd90d50` (2026-05-10) addressed INTERNAL middleware leaks within task subrouters but NOT the external leak from `projectsRoutes.use('/*')`.

### Issue 2: MCP Token 4h TTL (HIGH — Expires During Long Tasks)

MCP tokens have a 4-hour TTL (`DEFAULT_MCP_TOKEN_TTL_SECONDS = 14400`) with no sliding window on main. Agents running tasks longer than 4 hours lose MCP tool access. The user wants all auth tokens to last as long as the workspace is alive (up to 8 hours).

A sliding window implementation exists on branch `fix/agent-credential-lifecycle` (commit `d2094480`) but is not merged.

## Research Findings

### Key Files
- `apps/api/src/routes/projects/index.ts:11` — the middleware leak source (`use('/*', requireAuth())`)
- `apps/api/src/routes/tasks/crud.ts:452-475` — the task callback route to extract
- `apps/api/src/index.ts:528-531` — route mounting order
- `apps/api/src/routes/projects/node-acp-heartbeat.ts` — pattern to follow for extraction
- `apps/api/src/services/mcp-token.ts` — MCP token lifecycle (no sliding window on main)
- `packages/shared/src/constants/defaults.ts:108` — MCP TTL default (14400s = 4h)
- `apps/api/src/env.ts:258` — `MCP_TOKEN_TTL_SECONDS` env var
- `apps/api/src/routes/mcp/_helpers.ts:285` — validateMcpToken call site
- `apps/api/src/routes/project-deployment.ts:336` — validateMcpToken call site

### Existing Post-Mortems
- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` — same bug class
- `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md` — same bug class, same fix pattern
- `docs/notes/2026-03-17-mcp-token-ttl-too-short-postmortem.md` — MCP TTL invariant

### Fix Pattern (from deployment-identity-token fix)
Extract the callback-auth route into its own Hono instance, mount it at `/api/projects` BEFORE `projectsRoutes` in `index.ts`. This way it matches and returns before the wildcard middleware runs.

## Implementation Checklist

### Fix 1: Extract task callback route before projectsRoutes

- [ ] Create `apps/api/src/routes/tasks/callback.ts` — separate Hono subrouter with ONLY the `POST /:projectId/tasks/:taskId/status/callback` route (move from `crud.ts`)
- [ ] Remove the callback route from `apps/api/src/routes/tasks/crud.ts`
- [ ] Export `taskCallbackRoute` from `apps/api/src/routes/tasks/index.ts`
- [ ] Mount `taskCallbackRoute` at `/api/projects` BEFORE `projectsRoutes` in `apps/api/src/index.ts` with explanatory comment
- [ ] Write integration test through combined app routes proving callback accepts Bearer JWT (not blocked by session auth)

### Fix 2: MCP token sliding window + 8h TTL

- [ ] Update `DEFAULT_MCP_TOKEN_TTL_SECONDS` from 14400 (4h) to 28800 (8h) in `packages/shared/src/constants/defaults.ts`
- [ ] Add `MCP_TOKEN_MAX_LIFETIME_SECONDS` env var to `apps/api/src/env.ts` (default 24h = 86400)
- [ ] Add `lastRefreshedAt` optional field to `McpTokenData` in `apps/api/src/services/mcp-token.ts`
- [ ] Add `getMcpTokenMaxLifetime()` helper in `mcp-token.ts`
- [ ] Implement sliding window in `validateMcpToken()`: refresh KV TTL on each use, throttled to >50% of TTL elapsed, capped by max lifetime
- [ ] Update `validateMcpToken` signature to accept env parameter
- [ ] Update call sites: `mcp/_helpers.ts:285`, `project-deployment.ts:336`
- [ ] Write unit tests for sliding window: throttle, max lifetime, NaN createdAt handling

### Documentation & Process

- [ ] Write post-mortem in `docs/notes/2026-05-12-task-callback-middleware-leak-postmortem.md`
- [ ] Update `.env.example` with `MCP_TOKEN_MAX_LIFETIME_SECONDS`

## Acceptance Criteria

- [ ] Task callback endpoint accepts Bearer JWT callback tokens without 401 when tested through the combined app routes
- [ ] MCP tokens auto-extend their TTL while in active use (sliding window)
- [ ] MCP tokens expire after 8h of inactivity (default TTL)
- [ ] MCP tokens are rejected after 24h regardless of activity (max lifetime)
- [ ] Malformed `createdAt` causes token revocation (fail-closed)
- [ ] KV writes are throttled: only refresh when >50% of TTL elapsed
- [ ] All existing tests pass
- [ ] No hardcoded values — all configurable via env vars

## References

- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`
- `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md`
- `docs/notes/2026-03-17-mcp-token-ttl-too-short-postmortem.md`
- `.claude/rules/06-api-patterns.md` (Hono middleware scoping)
- Branch `fix/agent-credential-lifecycle` commit `d2094480` (sliding window reference)
