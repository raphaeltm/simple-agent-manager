# Fix Organization Repos Not Showing in Dropdowns

## Problem

When a user connects GitHub App installations for both personal and organization accounts, only personal repos appear in the repository dropdown during project creation. Organization repos are missing.

## Root Cause Analysis

Three interconnected bugs:

### Bug 1: RepoSelector ignores selected installation
**File**: `apps/web/src/components/RepoSelector.tsx:42`
The RepoSelector component doesn't accept an `installationId` prop. It fetches all repos from all installations on mount and never re-fetches when the user changes the installation dropdown in the parent ProjectForm.

### Bug 2: API installation_id filter uses wrong field
**File**: `apps/api/src/routes/github.ts:78`
The repositories endpoint filters by `i.installationId` (GitHub's numeric installation ID), but the client sends the DB row ID (`inst.id`). The branches endpoint (line 144) correctly uses `i.id`. This inconsistency means filtered queries silently return zero results.

### Bug 3: Silent failure swallows org repo fetch errors
**File**: `apps/api/src/routes/github.ts:101-106`
When `getInstallationRepositories()` fails for an org installation (e.g., token generation failure, permissions issue), `Promise.allSettled` catches it and only logs to console. The UI shows no indication that repos from some installations couldn't be loaded.

## Implementation Checklist

- [ ] Fix API `GET /api/github/repositories` to filter by DB row ID (`i.id`) instead of GitHub installation ID (`i.installationId`), matching the pattern used by the branches endpoint
- [ ] Update `RepoSelector` to accept an `installationId` prop
- [ ] Make `RepoSelector` call `listRepositories(installationId)` when prop is provided
- [ ] Add `installationId` to the `useEffect` dependency array so repos re-fetch on change
- [ ] Update `ProjectForm` to pass `values.installationId` to `RepoSelector`
- [ ] Clear repo selection in ProjectForm when installation changes
- [ ] Surface partial fetch failures in the RepoSelector UI (warning message)
- [ ] Update API to return error metadata (which installations failed) alongside successful repos
- [ ] Write tests for RepoSelector with installationId prop
- [ ] Write tests for API installation_id filter fix
- [ ] Run full quality suite (lint, typecheck, test, build)

## Acceptance Criteria

- [ ] User can select an org installation and see only that org's repos in the dropdown
- [ ] User can switch between installations and repos update accordingly
- [ ] If repo fetching fails for an installation, user sees a warning (not silent failure)
- [ ] Branch fetching works correctly for repos from any installation
- [ ] Existing functionality (manual URL entry, repo search) continues to work
- [ ] All tests pass, no lint/typecheck errors

## References

- `apps/api/src/routes/github.ts` — GitHub API routes
- `apps/api/src/services/github-app.ts` — GitHub App token/repo service
- `apps/web/src/components/RepoSelector.tsx` — Repo selector component
- `apps/web/src/components/project/ProjectForm.tsx` — Project form
- `apps/web/src/lib/api.ts` — API client (listRepositories)
