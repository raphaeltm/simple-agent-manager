# Harden setup/bootstrap token and auth boundaries

## Problem

CTO backend review found first-run setup/bootstrap token handling and auth boundaries need hardening. The change must stay tightly scoped to `apps/api` backend paths and preserve existing valid flows/API shapes.

## Research findings

- `apps/api/src/routes/setup.ts` exposes unauthenticated `/api/setup/status`, `/verify`, `/config`, and `/complete` while first-run setup is open, gated by `SETUP_TOKEN`.
- `apps/api/src/services/platform-config.ts` verifies setup tokens with D1-backed rate limiting and constant-time comparison.
- `POST /api/setup/complete` currently writes integration config before setting `setup.completed`, so validation/completion races or failures can leave partial runtime setup state.
- `apps/api/src/routes/bootstrap.ts` redeems VM bootstrap tokens with token-as-auth and returns existing response shape.
- `apps/api/src/services/bootstrap.ts` redeems KV tokens with `get` then `delete`, which is single-use in normal flow but can race under concurrent duplicate redemption.
- Existing tests: `apps/api/tests/unit/routes/setup.test.ts`, `apps/api/tests/unit/services/platform-config.test.ts`, `apps/api/tests/unit/routes/bootstrap.test.ts`.

## Implementation checklist

- [x] Add a D1 transaction helper for first-run setup completion so config writes and `setup.completed` update succeed/fail as one unit when D1 supports transactions.
- [x] Keep a compatibility fallback for test/minimal D1 shims and existing deployments without changing public API shape.
- [x] Fail closed for invalid/missing/misused setup token and closed setup cases before writes.
- [x] Harden bootstrap token redemption against concurrent/replay use where practical without changing the response shape.
- [x] Add scenario tests for setup success, invalid token, unauthorized/closed setup access, partial-state prevention, and double-submit/replay behavior.
- [x] Add bootstrap tests for invalid token, valid token, replay/double-submit behavior, and malformed token data failing closed.
- [x] Run relevant local tests and full applicable validation.
- [x] Run specialist review with security/test quality critique and address findings.
- [x] Open PR on `sam/execute-task-using-skill-837fbj`, wait for CI to be green, and do not merge.

## Acceptance criteria

- Existing valid setup and bootstrap flows keep the same API shape.
- Invalid tokens and closed/replayed setup/bootstrap attempts fail closed.
- Setup completion does not persist partial setup config when completion cannot be atomically finalized.
- Local tests and CI are green.
- PR description explicitly says no breaking changes and lists test/CI evidence.
