# Terminal Token Route Hardening

## Problem

A 2026-05-10 spot check of `apps/api/src/routes/terminal.ts` found that the terminal token endpoint does not meet the repository quality bar.

The codebase defines a dedicated `rateLimitTerminalToken()` middleware and exposes `RATE_LIMIT_TERMINAL_TOKEN`, but `POST /api/terminal/token` does not apply that limiter. This leaves a token-minting endpoint protected only by normal session auth, despite the route being called out as rate-limited elsewhere in the codebase.

The same route also lacks direct route-level regression tests. Existing worker tests only assert that `/api/terminal/token` rejects unauthenticated requests. They do not prove successful token generation, workspace ownership checks, workspace status checks, workspace URL construction, terminal activity update behavior, or rate-limit enforcement.

## Research Findings

- `apps/api/src/routes/terminal.ts`
  - Requires auth and approval for all terminal routes.
  - Validates request bodies with `TerminalRequestSchema`.
  - Checks workspace ownership before minting a terminal JWT.
  - Allows token generation for `running`, `recovery`, and `creating` workspaces.
  - Updates ProjectData terminal activity as best-effort background work.
  - Does not apply `rateLimitTerminalToken()`.
- `apps/api/src/middleware/rate-limit.ts`
  - Defines `DEFAULT_RATE_LIMITS.TERMINAL_TOKEN = 60`.
  - Exports `rateLimitTerminalToken(env)` with key prefix `terminal-token`.
- `apps/api/src/env.ts`
  - Defines `RATE_LIMIT_TERMINAL_TOKEN`.
- `apps/api/tests/workers/route-auth-validation.test.ts`
  - Covers unauthenticated rejection for `/api/terminal/token`.
  - Explicitly documents broader authenticated route coverage gaps.
- No direct `apps/api/tests/**/terminal*.test.ts` route tests exist.

## Implementation Checklist

- [x] Apply `rateLimitTerminalToken(c.env)` to `POST /api/terminal/token`.
- [x] Keep `POST /api/terminal/activity` unthrottled by the token minting limiter unless a separate activity heartbeat limiter is intentionally introduced.
- [x] Add focused API route tests proving:
  - [x] authenticated owners can mint a terminal token for accessible workspaces;
  - [x] token responses include a workspace URL derived from `BASE_DOMAIN` and workspace ID;
  - [x] workspaces owned by another user are rejected;
  - [x] inaccessible workspace statuses are rejected;
  - [x] token minting enforces `RATE_LIMIT_TERMINAL_TOKEN` and emits rate-limit headers.
- [x] Avoid brittle source-contract tests; test behavior through Hono route execution or worker runtime behavior.
- [x] Run focused tests for the new coverage.
- [x] Run API lint/typecheck and broader validation required by `/do`.

## Acceptance Criteria

- `POST /api/terminal/token` uses the existing terminal-token rate limiter.
- Tests fail on the pre-fix behavior and pass after the fix.
- Terminal activity heartbeat behavior is not accidentally throttled by token minting limits.
- No unrelated route behavior or auth semantics change.
- Quality checks are run and any remaining blocker is documented with exact command output.

## References

- `apps/api/src/routes/terminal.ts`
- `apps/api/src/middleware/rate-limit.ts`
- `apps/api/src/env.ts`
- `apps/api/tests/workers/route-auth-validation.test.ts`
- `docs/architecture/secrets-taxonomy.md`
