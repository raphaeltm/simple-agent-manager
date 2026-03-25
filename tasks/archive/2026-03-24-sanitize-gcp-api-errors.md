# Sanitize GCP API Errors

## Problem

When GCP API calls fail during the OIDC setup flow, raw GCP error responses are propagated directly to the client. These errors expose:
- Internal GCP resource paths (project IDs, pool names, provider names)
- IAM policy details
- Service account email addresses
- Internal error codes and stack traces

## Research Findings

### Error propagation paths

1. **`gcp-setup.ts`** — All functions (`listGcpProjects`, `getProjectNumber`, `enableApis`, `createWifPool`, `createOidcProvider`, `updateOidcProvider`, `createServiceAccount`, `grantWifUserOnSa`, `grantProjectRoles`, `pollOperation`) throw raw `Error` objects containing HTTP status + full GCP response body text.

2. **`gcp-sts.ts`** — `getGcpAccessToken()` throws raw errors containing STS token exchange and SA impersonation response bodies.

3. **`gcp-deploy-setup.ts`** — `runGcpDeploySetup()` calls all of the above without try/catch — errors propagate upward.

4. **`routes/gcp.ts`** — Two problematic patterns:
   - `GET /projects` (line 51-55): catches errors but passes raw `err.message` to `errors.badRequest()`
   - `POST /setup` (line 175-180): same pattern — `errors.badRequest(\`GCP setup failed: ${err.message}\`)`
   - `POST /verify` (line 216-222): returns `err.message` directly in JSON response

5. **`routes/project-deployment.ts`** — Line 138: `runGcpDeploySetup()` has NO try-catch — errors propagate to global handler which returns raw `err.message` as HTTP 500.

6. **Global error handler** (`index.ts:331-345`): For non-AppError errors, returns `err.message` verbatim as the HTTP response message.

### Approach

Create a `GcpApiError` class and a `sanitizeGcpError()` helper that:
- Maps GCP HTTP status codes to user-friendly messages
- Identifies common failure modes (permission denied, quota exceeded, not found, timeout)
- Logs full error details server-side
- Returns only sanitized messages to the client

Wrap all GCP service calls in route handlers with try/catch that uses sanitization.

## Implementation Checklist

- [ ] Create `GcpApiError` class in `apps/api/src/services/gcp-errors.ts`
- [ ] Add `sanitizeGcpError()` function that maps GCP errors to user-friendly messages
- [ ] Update `gcp-setup.ts` to throw `GcpApiError` instead of raw `Error` (preserves step context)
- [ ] Update `gcp-sts.ts` to throw `GcpApiError` instead of raw `Error`
- [ ] Update `routes/gcp.ts` catch blocks to use `sanitizeGcpError()` — return sanitized messages only
- [ ] Add try-catch to `routes/project-deployment.ts` line 138 around `runGcpDeploySetup()`
- [ ] Update `routes/gcp.ts` `/verify` endpoint to sanitize error in response body
- [ ] Write tests: mock GCP API failures and assert no internal paths leak in HTTP responses
- [ ] Verify with `pnpm typecheck && pnpm lint && pnpm test`

## Acceptance Criteria

- [ ] No raw GCP error details (resource paths, policy details, internal IDs) are returned to the client
- [ ] All GCP errors are logged server-side with full context for debugging
- [ ] Client receives user-friendly error messages that help them take action
- [ ] Tests verify that GCP errors are sanitized (mock a GCP API failure and assert the response body contains no internal paths)

## References

- `apps/api/src/services/gcp-setup.ts` — GCP setup service
- `apps/api/src/services/gcp-sts.ts` — GCP STS token exchange
- `apps/api/src/services/gcp-deploy-setup.ts` — GCP deploy setup
- `apps/api/src/routes/gcp.ts` — GCP route handlers
- `apps/api/src/routes/project-deployment.ts` — Deployment routes
- `apps/api/src/middleware/error.ts` — AppError class
- `packages/providers/src/provider-fetch.ts` — Reference error wrapping pattern
