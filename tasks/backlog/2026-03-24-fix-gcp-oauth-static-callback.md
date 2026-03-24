# Fix GCP OAuth Callback to Use Static URI

## Problem

The OAuth callback URI is per-project: `https://api.${BASE_DOMAIN}/api/projects/${projectId}/deployment/gcp/callback`. This means every SAM project requires a separate redirect URI registered in Google Cloud Console. Google doesn't support wildcard redirect URIs, making this feature unusable for any self-hoster with more than one project.

## Root Cause

The callback route is mounted as `/:id/deployment/gcp/callback` on the project deployment router, embedding the project ID in the URL. However, the project context is ALREADY stored in the KV state token (`gcp-deploy-oauth-state:${state}` → `{ projectId, userId }`), making the URL-embedded project ID redundant.

## Research Findings

### Key Files
- `apps/api/src/routes/project-deployment.ts` — authorize + callback handlers
- `apps/api/src/index.ts` — route registration
- `apps/api/tests/unit/routes/project-deployment.test.ts` — existing tests
- `apps/api/.env.example` — env var documentation
- `docs/guides/self-hosting.md` — self-hosting setup guide

### Prior Work
An agent pushed changes to branch `sam/fix-per-project-oauth-01kmgq` with commit `ca75ca2f`. The implementation is correct but the branch needs rebasing onto latest main.

### Implementation Approach
1. Authorize handler: change `redirectUri` to static `/api/deployment/gcp/callback`
2. Callback handler: move to new top-level `gcpDeployCallbackRoute` that reads projectId from KV state only
3. Register new route at `/api/deployment` in index.ts
4. Remove old per-project callback handler
5. Update tests, `.env.example`, and self-hosting docs

## Implementation Checklist

- [ ] 1. Rebase prior branch onto latest main
- [ ] 2. Verify authorize handler uses static redirect URI
- [ ] 3. Verify callback handler reads projectId from KV state only (no URL param)
- [ ] 4. Verify new route registered at `/api/deployment` in index.ts
- [ ] 5. Verify `.env.example` documents the static redirect URI
- [ ] 6. Verify `docs/guides/self-hosting.md` updated with redirect URI instructions
- [ ] 7. Verify tests cover: static URI in authorize, callback with state-based projectId, user mismatch, error cases
- [ ] 8. Run lint, typecheck, and tests

## Acceptance Criteria

- [ ] OAuth callback uses static URI `/api/deployment/gcp/callback`
- [ ] ProjectId comes exclusively from KV state token in callback
- [ ] Authorize handler sends static redirect URI to Google
- [ ] Token exchange uses matching static redirect URI
- [ ] `.env.example` documents the redirect URI to register
- [ ] Self-hosting guide includes redirect URI setup
- [ ] All existing + new tests pass
- [ ] No hardcoded values (constitution Principle XI compliance)
