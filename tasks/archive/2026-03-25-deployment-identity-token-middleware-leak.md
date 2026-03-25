# Fix: GCP deployment-identity-token endpoint returns 401 due to Hono middleware leak

**Created**: 2026-03-25
**Type**: Bug fix
**Priority**: High — blocks entire GCP deployment credential flow

## Problem

The `GET /api/projects/:id/deployment-identity-token` endpoint returns 401 "Authentication required" when called with a valid MCP Bearer token. GCP client libraries cannot obtain a subject token for STS token exchange.

## Root Cause

Hono middleware leak — same bug class as `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`.

1. `projectsRoutes` has `use('/*', requireAuth(), requireApproved())` (projects/index.ts:8)
2. `projectDeploymentRoutes` is mounted at the same base path `/api/projects` (index.ts:646)
3. Hono merges routes — wildcard `requireAuth()` leaks to all `/api/projects/*` routes
4. `requireAuth()` expects session cookies, rejects MCP Bearer token → 401
5. The endpoint's own MCP token auth (project-deployment.ts:322-338) never executes

## Research Findings

- **Key files**:
  - `apps/api/src/routes/project-deployment.ts` — identity token endpoint (line 322), exports `projectDeploymentRoutes` and `gcpDeployCallbackRoute`
  - `apps/api/src/routes/projects/index.ts` — wildcard middleware (line 8)
  - `apps/api/src/index.ts` — mounting at lines 640 (`projectsRoutes`) and 646 (`projectDeploymentRoutes`)
- **Existing pattern**: `workspace-callback-auth-routing.test.ts` tests combined routes for middleware leak
- **Rule**: `.claude/rules/06-api-patterns.md` already documents this middleware leak class
- **Other deployment routes** (OAuth flow, setup, management) all use `requireAuth()` per-route already, so they're just double-authed — not broken

## Implementation Checklist

- [ ] Extract `deployment-identity-token` GET route into a new Hono instance (`deploymentIdentityTokenRoute`) in `project-deployment.ts`
- [ ] Export `deploymentIdentityTokenRoute` from `project-deployment.ts`
- [ ] Mount `deploymentIdentityTokenRoute` at `/api/projects` in `index.ts` BEFORE `projectsRoutes` (mount order matters for Hono)
- [ ] Write routing test following `workspace-callback-auth-routing.test.ts` pattern: send Bearer MCP token through COMBINED app routes, assert NOT 401
- [ ] Write post-mortem in `docs/notes/2026-03-25-deployment-identity-token-middleware-leak-postmortem.md`
- [ ] Verify existing tests still pass
- [ ] Update `.claude/rules/06-api-patterns.md` if needed (may already be covered)

## Acceptance Criteria

- [ ] `GET /api/projects/:id/deployment-identity-token` with valid MCP Bearer token does NOT return 401 "Authentication required"
- [ ] Session-auth routes under `/api/projects` still require session auth
- [ ] Routing test covers the combined app routes (not individual subrouters)
- [ ] Post-mortem documents the incident and process fix
- [ ] All existing tests pass

## References

- `docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md` — prior incident
- `apps/api/tests/unit/workspace-callback-auth-routing.test.ts` — test pattern
- `.claude/rules/06-api-patterns.md` — middleware scoping rules
