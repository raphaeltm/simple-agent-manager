# Callback JWT auth regression tests

## Problem

API callback routes are a recurring risk area because VM agents authenticate with callback JWT bearer tokens while nearby user-facing routes use BetterAuth session middleware. Previous incidents show Hono wildcard middleware mounted on sibling routers can leak across shared base paths and block callback JWT routes.

This task adds non-breaking regression coverage for callback JWT scope and auth route invariants. Behavior must not be tightened unless the existing test suite and code audit prove it is safe.

## Research findings

- `apps/api/src/routes/tasks/callback.ts` handles `POST /api/projects/:projectId/tasks/:taskId/status/callback` and calls `verifyCallbackToken(token, env, { expectedScope: 'workspace' })`.
- `apps/api/src/routes/deploy-release-callback.ts` handles node deployment callbacks under `/api/nodes/:id/*` and calls `verifyCallbackToken(token, env, { expectedScope: 'node' })` through `verifyNodeCallback`.
- `apps/api/src/routes/bootstrap.ts` redeems `/api/bootstrap/:token` without bearer JWT auth; the bootstrap token is the auth mechanism. It intentionally preserves legacy plaintext `callbackToken` fallback for in-flight tokens.
- `apps/api/src/services/jwt.ts` preserves legacy no-scope callback token compatibility only when `expectedScope` is omitted; callers that pass `expectedScope` reject legacy/no-scope tokens.
- `.claude/rules/06-api-patterns.md` requires auth routing tests to exercise combined mounted routes because middleware leakage only appears when sibling routers are mounted together.
- `.claude/rules/34-vm-agent-callback-auth.md` requires VM agent callback routes to be separate, callback-JWT authenticated, and mounted before session-auth routes.

## Checklist

- [x] Map callback routes and expected token scopes in task notes and tests.
- [x] Add route-level regression tests for task callback expected-scope behavior through the combined `/api/projects` app.
- [x] Add route-level regression tests for deploy-release callback auth behavior through the combined `/api/nodes` app to prevent session middleware leakage.
- [x] Keep any code changes refactor-only/no behavior change, or avoid code changes entirely.
- [x] Run relevant API tests and typecheck.
- [x] Run local security/test reviews and address findings.
- [x] Create PR on `sam/execute-task-using-skill-zr6j53` and do not merge. (pending final PR step)

## Acceptance criteria

- Callback route map is documented.
- Tests prove callback endpoints are handled by callback JWT auth, not session-cookie middleware.
- Tests assert workspace-vs-node expected scope invariants without removing legacy compatibility where still intended.
- Relevant API test suite and typecheck pass.
- PR is opened and CI is green.
- PR is not merged.
