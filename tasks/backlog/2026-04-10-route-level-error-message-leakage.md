# Route-Level Error Message Leakage

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
