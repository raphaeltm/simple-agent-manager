# Fix: OAuth handle leaked in URL query parameter

## Problem

In both GCP OAuth flows, the OAuth handle (an opaque KV token reference) is passed as a URL query parameter in the callback redirect. This leaks the handle to:
- Browser history
- Referer headers sent to subsequent pages
- Server access logs
- Browser extensions that read URLs

### Affected Flows

1. **Project deployment flow** (`apps/api/src/routes/project-deployment.ts:485`):
   `c.redirect(\`${appUrl}?gcp_deploy_setup=${encodeURIComponent(handle)}\`)`
   → Consumed by `apps/web/src/components/DeploymentSettings.tsx:65`

2. **GCP credential flow** (`apps/api/src/routes/google-auth.ts:109`):
   `c.redirect(\`${appUrl}?gcp_setup=${encodeURIComponent(handle)}\`)`
   → Consumed by `apps/web/src/components/GcpCredentialForm.tsx:55`

## Research Findings

- Both callbacks store the Google access token in KV with an opaque handle UUID, then redirect with the handle in URL query params
- The deployment callback (`gcpDeployCallbackRoute`) already has `requireAuth()` + `requireApproved()` middleware, so the session user is known
- The credential callback (`google-auth.ts`) does NOT have auth middleware on the callback — but the deployment flow proves auth cookies survive the Google redirect, so we can add it
- The frontend reads the handle from URL params, removes it from the URL, then uses it for subsequent authenticated API calls
- The handle has a 5-minute TTL (`DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS`)
- Existing test file: `apps/api/tests/unit/routes/project-deployment.test.ts`

## Fix Approach

**Store handles server-side, retrieve via authenticated endpoint.** Instead of passing the handle in the redirect URL:

1. After token exchange, store the handle in KV keyed by user identity (e.g., `gcp-deploy-oauth-result:<userId>:<projectId>`)
2. Redirect with only a flag parameter: `?gcp_deploy_setup=ready` (no handle)
3. Add authenticated pickup endpoints that return the handle and delete the KV entry (one-time use)
4. Frontend calls the pickup endpoint to retrieve the handle, then proceeds as before

## Implementation Checklist

### Backend — Flow 1 (Deployment)
- [ ] In `gcpDeployCallbackRoute` callback handler (`project-deployment.ts`): store handle in KV as `gcp-deploy-oauth-result:<userId>:<projectId>` with same TTL
- [ ] Change redirect from `?gcp_deploy_setup=${handle}` to `?gcp_deploy_setup=ready`
- [ ] Add `GET /api/projects/:id/deployment/gcp/oauth-result` endpoint (authenticated) that looks up the result, returns `{ handle }`, and deletes the KV entry

### Backend — Flow 2 (Credential)
- [ ] Add `requireAuth()` to google-auth.ts callback and store userId in state KV entry
- [ ] In callback: store handle in KV as `gcp-oauth-result:<userId>` with same TTL
- [ ] Change redirect from `?gcp_setup=${handle}` to `?gcp_setup=ready`
- [ ] Add `GET /api/gcp/oauth-result` endpoint (authenticated) that looks up the result, returns `{ handle }`, and deletes the KV entry

### Frontend
- [ ] `DeploymentSettings.tsx`: When seeing `?gcp_deploy_setup=ready`, call new pickup endpoint to get handle, then proceed as before
- [ ] `GcpCredentialForm.tsx`: When seeing `?gcp_setup=ready`, call new pickup endpoint to get handle, then proceed as before
- [ ] `api.ts`: Add API client functions for both pickup endpoints

### Tests
- [ ] Update existing test in `project-deployment.test.ts` to verify redirect URL does NOT contain the handle value
- [ ] Add test for new `oauth-result` pickup endpoint (happy path + expired/missing)
- [ ] Add regression test: callback redirect URL never contains a UUID-shaped token as a query parameter value

### Documentation
- [ ] Update any docs referencing the OAuth callback flow

## Acceptance Criteria

- [ ] OAuth handle is no longer visible in any URL (query params, fragments)
- [ ] The OAuth flow still works end-to-end (authorize → Google consent → callback → GCP project selection)
- [ ] Existing functionality is not broken (test on staging)
- [ ] Regression test verifying the handle doesn't appear in redirect URLs
