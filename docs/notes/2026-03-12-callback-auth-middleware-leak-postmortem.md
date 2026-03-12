# Post-Mortem: Hono Middleware Leak Blocks All VM→API Callbacks

**Date**: 2026-03-12
**Severity**: P0 — All VM→API callbacks broken (provisioning-failed, ready, agent-key, boot-log, etc.)
**Duration**: Since workspace callback routes were split into subrouters (unknown exact date) until fix deployed
**Root cause**: `crudRoutes.use('/*', requireAuth())` wildcard middleware leaked across subrouters mounted at the same base path, intercepting callback-authenticated endpoints

## What Broke

VM agent callbacks to the control plane API return 401 "Authentication required". Affected endpoints:
- `POST /api/workspaces/:id/provisioning-failed` — VM reports provisioning failure
- `POST /api/workspaces/:id/ready` — VM reports workspace ready
- `POST /api/workspaces/:id/agent-key` — VM fetches agent credentials
- `POST /api/workspaces/:id/boot-log` — VM sends provisioning logs
- `POST /api/workspaces/:id/agent-settings` — VM fetches agent configuration
- `POST /api/workspaces/:id/agent-credential-sync` — VM syncs updated credentials

The task runner gets stuck indefinitely because it never receives workspace readiness/failure callbacks from the VM.

## Root Cause

In `apps/api/src/routes/workspaces/crud.ts:29`:
```typescript
crudRoutes.use('/*', requireAuth(), requireApproved());
```

This wildcard middleware was intended to protect CRUD routes only. However, in `workspaces/index.ts`, four subrouters are mounted at the same base path:

```typescript
workspacesRoutes.route('/', crudRoutes);       // has use('/*', requireAuth())
workspacesRoutes.route('/', lifecycleRoutes);   // mixed: user-auth + callback-auth
workspacesRoutes.route('/', agentSessionRoutes); // has use('/*', requireAuth())
workspacesRoutes.route('/', runtimeRoutes);      // callback-auth only
```

When Hono merges subrouters mounted at the same base path, wildcard middleware from one subrouter can intercept requests destined for another. The `requireAuth()` middleware from `crudRoutes` runs on ALL `/api/workspaces/*` requests — including callback-authenticated endpoints in `lifecycleRoutes` and `runtimeRoutes`.

The VM agent sends Bearer JWT tokens for callbacks, but `requireAuth()` expects BetterAuth session cookies → 401 "Authentication required".

**Error message mismatch was the diagnostic clue**: Production logs showed "Authentication required" (from `requireAuth()` in `middleware/auth.ts:44`), NOT "Missing or invalid Authorization header" (from `verifyWorkspaceCallbackAuth()` in `_helpers.ts:100`). This proved the callback handler's auth function was never reached.

## Timeline

1. **Unknown date**: Workspace routes split into subrouters (crud, lifecycle, agent-sessions, runtime)
2. **Unknown date**: `crudRoutes.use('/*', requireAuth())` added as global middleware
3. **2026-03-12**: Same-zone routing fix deployed; workspace creation now reaches VMs
4. **2026-03-12**: VM provisioning fails; `provisioning-failed` callback returns 401
5. **2026-03-12**: Root cause identified via error message analysis + Hono routing trace
6. **2026-03-12**: Fix deployed — per-route middleware replaces wildcard `use()`

## Why It Wasn't Caught

1. **No integration test through combined routes**: Tests exercised individual subrouters in isolation, where the middleware leak doesn't manifest. The bug only appears when subrouters are mounted together.
2. **Source-contract tests gave false confidence**: The existing `workspace-lifecycle.test.ts` uses `readFileSync` + `toContain()` to verify code structure. These tests pass regardless of middleware routing behavior.
3. **No end-to-end callback test**: No test sent a Bearer-token request to a callback endpoint through the combined `workspacesRoutes` app.
4. **Previous bugs masked this one**: Same-zone routing prevented workspace creation from reaching VMs at all, so the callback auth bug was latent until the routing fix.

## Class of Bug

**Hono middleware scope leak**: When multiple Hono subrouters are mounted at the same base path via `app.route('/', subRouter)`, wildcard middleware (`use('/*', ...)`) defined in one subrouter can intercept requests intended for other subrouters. This violates the expectation that `use()` is scoped to its own subrouter.

**General class**: Framework routing assumption violations — middleware scoping behavior that differs from developer expectation, invisible in unit tests, only manifests in the combined application.

## Fix

Replaced `crudRoutes.use('/*', requireAuth(), requireApproved())` with per-route middleware on each CRUD endpoint:

```typescript
// Before (leaks to all subrouters):
crudRoutes.use('/*', requireAuth(), requireApproved());
crudRoutes.get('/', async (c) => { ... });

// After (scoped to this route only):
crudRoutes.get('/', requireAuth(), requireApproved(), async (c) => { ... });
```

Same change applied to `agentSessionRoutes` as a defensive fix.

## Process Fix

Added rule to `.claude/rules/06-api-patterns.md`:
- **Never use wildcard `use()` middleware on subrouters that share a base path** with other subrouters using different auth models. Apply auth as per-route middleware instead.
- **Auth routing tests must go through the combined routes app**, not individual subrouters.

## Verification

1. Behavioral test `workspace-callback-auth-routing.test.ts` verifies:
   - Callback endpoints accept Bearer tokens (not blocked by session auth)
   - CRUD endpoints still require session auth
   - Test runs through combined `workspacesRoutes`, not individual subrouters
2. Full test suite passes
3. Production deployment + task submission verification
