# Post-Mortem: Hono Middleware Leak Blocks Deployment Identity Token Endpoint

**Date**: 2026-03-25
**Severity**: P1 — GCP deployment credential flow completely broken for agents
**Duration**: Since `projectDeploymentRoutes` was mounted at `/api/projects` until fix deployed
**Root cause**: `projectsRoutes.use('/*', requireAuth())` wildcard middleware leaked to `projectDeploymentRoutes` because both mount at the same base path `/api/projects`

## What Broke

`GET /api/projects/:id/deployment-identity-token` returns 401 "Authentication required" when called with a valid MCP Bearer token. This endpoint is called by GCP client libraries (via `external_account` credential config) to obtain a subject token for STS token exchange. With it broken, no agent can authenticate to GCP for deployment operations.

## Root Cause

Identical bug class to the workspace callback auth middleware leak (`docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md`).

In `apps/api/src/routes/projects/index.ts:8`:
```typescript
projectsRoutes.use('/*', requireAuth(), requireApproved());
```

In `apps/api/src/index.ts`:
```typescript
app.route('/api/projects', projectsRoutes);          // line 640 — has wildcard requireAuth()
app.route('/api/projects', projectDeploymentRoutes);  // line 646 — identity token uses MCP auth
```

When Hono merges subrouters mounted at the same base path, wildcard middleware from one subrouter leaks to ALL sibling subrouters. The `requireAuth()` middleware from `projectsRoutes` runs on all `/api/projects/*` requests — including the `deployment-identity-token` endpoint that uses MCP Bearer token auth, not session cookies.

The endpoint's own MCP token authentication (`project-deployment.ts:322-338`) never executes because `requireAuth()` rejects the request first.

## Timeline

1. **2026-03-24**: GCP deployment credential feature shipped (PR #499)
2. **2026-03-25**: Identity token endpoint discovered to be non-functional — returns 401
3. **2026-03-25**: Root cause identified — same middleware leak class as March 12 incident
4. **2026-03-25**: Fix deployed — identity token route extracted to separate Hono instance

## Why It Wasn't Caught

1. **No integration test through combined routes**: The deployment endpoint was tested in isolation (individual subrouter), where the middleware leak doesn't manifest. The bug only appears when subrouters are mounted together in the combined app.
2. **Prior incident rule was not applied proactively**: The `.claude/rules/06-api-patterns.md` rule about middleware scoping existed since March 12, but wasn't checked when mounting `projectDeploymentRoutes` at the same base path as `projectsRoutes`.
3. **The identity token endpoint is called by GCP libraries, not by the UI**: Manual testing of the OAuth flow and setup UI wouldn't exercise this endpoint.

## Class of Bug

**Hono middleware scope leak** — identical to the March 12 incident. When multiple Hono subrouters are mounted at the same base path, wildcard middleware from one leaks to all siblings.

**Specific pattern**: A subrouter with `use('/*', requireAuth())` mounted at the same base path as a subrouter with a Bearer-token-authenticated endpoint.

## Fix

Extracted the `deployment-identity-token` endpoint into its own Hono instance (`deploymentIdentityTokenRoute`) and mounted it BEFORE `projectsRoutes` in `index.ts`:

```typescript
// Before (leaks):
app.route('/api/projects', projectsRoutes);          // has use('/*', requireAuth())
app.route('/api/projects', projectDeploymentRoutes);  // identity token endpoint blocked

// After (isolated):
app.route('/api/projects', deploymentIdentityTokenRoute);  // MCP auth — no wildcard middleware
app.route('/api/projects', projectsRoutes);
app.route('/api/projects', projectDeploymentRoutes);       // remaining routes use per-route auth
```

## Process Fix

1. **Routing regression test added**: `deployment-identity-token-auth-routing.test.ts` tests the identity token endpoint through the COMBINED app routes and asserts it is not blocked by session auth.
2. **Rule reinforcement**: The existing rule in `.claude/rules/06-api-patterns.md` covers this class, but the check should be part of the preflight for any change that mounts a new subrouter at an existing base path.

## Verification

1. Behavioral test `deployment-identity-token-auth-routing.test.ts` verifies:
   - Identity token endpoint accepts MCP Bearer tokens (not blocked by session auth)
   - Identity token endpoint without auth is NOT intercepted by session auth middleware
   - Project CRUD endpoints still require session auth
   - All tests run through combined app routes (not individual subrouters)
2. Full test suite passes
3. Staging deployment + identity token endpoint verification
