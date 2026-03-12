# Fix Workspace Callback Auth Middleware Leak (401 on VM→API Callbacks)

**Date**: 2026-03-12
**Severity**: P0 — All VM→API callbacks broken in production (provisioning-failed, ready, boot-log, agent-key, agent-settings, agent-credential-sync)

## Problem

VM agent callbacks to the API (`POST /api/workspaces/:id/provisioning-failed`, `/ready`, `/agent-key`, etc.) return 401 "Authentication required". The task runner gets stuck indefinitely because it never learns about workspace provisioning failures.

## Root Cause

`crudRoutes.use('/*', requireAuth(), requireApproved())` at `apps/api/src/routes/workspaces/crud.ts:29` applies session-based auth middleware to ALL workspace routes via Hono wildcard middleware. When mounted alongside `lifecycleRoutes` and `runtimeRoutes` at the same base path `/` in `workspaces/index.ts`, the wildcard middleware intercepts callback-authenticated endpoints before their handlers run.

The VM agent sends Bearer JWT tokens for callbacks, but `requireAuth()` expects BetterAuth session cookies → 401.

**Evidence**: Production logs show `POST /api/workspaces/:id/provisioning-failed` → 401 "Authentication required" (the error message from `requireAuth()`, NOT from `verifyWorkspaceCallbackAuth()`).

## Fix

- [x] Remove `crudRoutes.use('/*', requireAuth(), requireApproved())` wildcard middleware from `crud.ts`
- [x] Apply `requireAuth(), requireApproved()` as per-route middleware on each CRUD endpoint
- [x] Remove `agentSessionRoutes.use('/*', requireAuth(), requireApproved())` from `agent-sessions.ts` (same pattern, defensive fix)
- [x] Apply `requireAuth(), requireApproved()` as per-route middleware on each agent-session endpoint
- [x] Add behavioral integration test through combined `workspacesRoutes` that verifies callback-auth endpoints accept Bearer tokens and reject missing auth
- [x] Add behavioral test that verifies CRUD endpoints still require session auth
- [x] Write post-mortem in `docs/notes/`
- [x] Process fix in `.claude/rules/`

## Acceptance Criteria

- [ ] `POST /api/workspaces/:id/provisioning-failed` with valid Bearer token returns 200 (not 401)
- [ ] `POST /api/workspaces/:id/ready` with valid Bearer token returns 200 (not 401)
- [ ] All runtime callback endpoints (`/agent-key`, `/boot-log`, etc.) work with Bearer tokens
- [ ] CRUD endpoints (`GET /`, `POST /`, `DELETE /:id`) still require session auth
- [ ] Integration tests verify auth routing through combined `workspacesRoutes` app
- [ ] Post-mortem documents root cause and class of bug
- [ ] Process fix prevents middleware leak class of bugs

## References

- `apps/api/src/routes/workspaces/crud.ts:29` — root cause line
- `apps/api/src/routes/workspaces/index.ts` — mounting structure
- `apps/api/src/routes/workspaces/lifecycle.ts:189-306` — callback-auth routes
- `apps/api/src/routes/workspaces/runtime.ts` — more callback-auth routes
- `apps/api/src/middleware/auth.ts:44` — "Authentication required" error source
- `tasks/backlog/2026-03-12-provisioning-failed-callback-401.md` — initial bug report
