# Route-Level Error Message Leakage

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - The GitHub install callback redirect uses fixed reason codes (`installation_save_failed`,
>     `installation_lookup_failed`; `apps/api/src/routes/github.ts:440–441`; PR #1025 dd47c31ff).
>   - The env var name is gone from the slug error ("GitHub App slug is not configured",
>     `github.ts:95`; PR #1528 96c1703e0).
> - **Still open:**
>   - Two `errors.internal()` calls still send raw error text to clients: `github.ts:261`
>     (`Failed to list branches: ${message}`) and `apps/api/src/routes/tts.ts:69`
>     (`TTS synthesis failed: ${errorMessage}`). `handleAppError` returns AppError bodies
>     unchanged (`apps/api/src/middleware/app-error-handler.ts:115–117`).
>   - Tests proving internal details stay out of responses.
>   - Same class of bug: the knowledge REST routes pass raw `err.message` to clients
>     (`apps/api/src/routes/knowledge.ts:237,296,346,364`); tracked in
>     `2026-04-13-knowledge-graph-hardening.md`.

## Problem

Multiple route handlers forward raw `err.message` into `errors.internal()` responses, which bypasses the global error handler's generic message because `AppError` instances pass through unchanged. Additionally, the GitHub App installation callback appends raw error messages to browser redirect URLs.

Discovered during security audit of PR for api-security-error-leakage task.

## Affected Files

- `apps/api/src/routes/github.ts:194` — `throw errors.internal('Failed to list branches: ${message}')`
- `apps/api/src/routes/github.ts:66` — `throw errors.internal('GITHUB_APP_SLUG environment variable not configured')`
- `apps/api/src/routes/github.ts:371` — `c.redirect(...?reason=${encodeURIComponent(message)})`
- `apps/api/src/routes/tts.ts:69` — `throw errors.internal('TTS synthesis failed: ${errorMessage}')`

## Acceptance Criteria

- [ ] All `errors.internal(err.message)` patterns replaced with opaque messages
- [ ] GitHub redirect URL uses fixed error code instead of dynamic message
- [ ] Env var names removed from error messages returned to clients
- [ ] Tests verify that internal error details do not appear in responses
