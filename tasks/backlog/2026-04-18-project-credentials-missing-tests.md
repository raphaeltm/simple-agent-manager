# Missing test coverage for project credential overrides (PR #753)

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** HIGH #2. `apps/api/tests/unit/routes/project-credentials.test.ts:127-212` covers
>   the GET route: cross-user 404, empty list, masked key, `scope` and `projectId`.
> - **Still open:**
>   - HIGH #5, retargeted: the component is now `ProjectAgentsSection` / `ProjectAgentCard`
>     (PR #757). `apps/web/tests/unit/components/project-agents-section.test.tsx` covers the
>     inherit hint (:87), list error (:171) and delete (:185). Missing: the credential save flow
>     (`saveProjectAgentCredential` is mocked but never used), the Retry button
>     (`ProjectAgentsSection.tsx:143`) and the "No user-level credential" copy
>     (`ProjectAgentCard.tsx:186`).
>   - HIGH #6: no route-level test of `POST /:id/agent-key`
>     (`apps/api/src/routes/workspaces/runtime.ts:864`) with and without a project. Resolution is
>     only tested at service level (`project-credentials.test.ts:516-700`).
>   - LOW #9: the DELETE 400 cases (`apps/api/src/routes/projects/credentials.ts:512-517`).
>   - LOW #10: a route-level project PUT update (200, `createdAt` kept). The route now calls
>     `saveAgentCredentialForUser`; only a user-scope service test covers replacement
>     (`apps/api/tests/workers/agent-credential-save-dual-write.test.ts:129`).

**Created**: 2026-04-18
**Priority**: HIGH
**Source**: test-engineer review rerun on PR #753 (`sam/project-credential-overrides`)

## Problem

test-engineer coverage analysis identified five gaps that are not covered by the existing
`2026-04-18-credentials-miniflare-integration-tests.md` backlog. Findings 1/3/4/7/8 from
that review are already tracked there — this task covers the remainder.

## Scope

### HIGH #2 — GET `/api/projects/:id/credentials` has zero coverage

**Location**: `apps/api/src/routes/projects/credentials.ts:37–93`

The GET handler decrypts every project-scoped credential row, masks the token (last 4
chars), tags the response with `scope: 'project'` + `projectId`, and gates access via
`requireOwnedProject`. Existing unit tests exercise PUT and DELETE only.

**Acceptance**:
- Unit test: GET returns empty list when project has no overrides
- Unit test: GET returns masked + decrypted credentials for owner
- Unit test: GET returns 404 when project belongs to another user
- Unit test: GET response objects carry `scope: 'project'` and `projectId`

### HIGH #5 — `ProjectAgentCredentialsSection` has no behavioral tests

**Location**: `apps/web/src/components/ProjectAgentCredentialsSection.tsx` (no test file exists)

Three interactive behaviors are unverified, violating `.claude/rules/02-quality-gates.md`
(Interactive Element Test Requirement):

1. `handleSave` — optimistic splice-and-append of `projectCreds` after `saveProjectAgentCredential` resolves
2. `handleDelete` — filter-remove after `deleteProjectAgentCredential` resolves; toast fires
3. Error-state Retry button — invokes `loadData()`
4. Fallback display — "Inheriting user credential (…last4)" appears only when `!hasOverride && hasUserFallback`
5. No-user-fallback display — "No user-level credential set for this agent…" copy

**Acceptance**:
- `apps/web/src/components/__tests__/ProjectAgentCredentialsSection.test.tsx` (new)
- Uses Vitest + Testing Library to `render()` the component
- Simulates save, delete, and retry interactions
- Asserts DOM updates (e.g., inheriting hint disappears after save, reappears after delete)

### HIGH #6 — No capability test through `workspaces/runtime.ts:49–55` callback

**Location**: `apps/api/src/routes/workspaces/runtime.ts` `/agent-key` callback

The workspace runtime endpoint passes `workspace.projectId` into `getDecryptedAgentKey`.
There is no test that:
1. Creates a workspace linked to a project with a project-scoped credential
2. Hits `/agent-key`
3. Asserts the returned key is the project-scoped one (not user-scoped)

Nor is there a test for the `workspace.projectId === null` branch (where the project lookup
is intentionally skipped).

**Acceptance**:
- Integration test (Miniflare or direct fetch-through-app) covers both branches
- Asserts `credentialSource` in the response path reflects the correct scope

### LOW #9 — DELETE validation branches untested

**Location**: `apps/api/src/routes/projects/credentials.ts:233–237`

DELETE route validates `agentType` via `isValidAgentType()` and `credentialKind` against
`['api-key', 'oauth-token']`, returning 400 on failure. Neither branch has a test.

**Acceptance**: two unit tests asserting 400 + error body for each invalid input.

### LOW #10 — PUT update path untested

**Location**: `apps/api/src/routes/projects/credentials.ts:164–188`

PUT has two branches: insert (no existing row) and update (existing row). Tests only
cover insert. The update path:
- Calls `db.update().set({encryptedToken, iv, isActive, updatedAt}).where(eq(id, existingCred.id))`
- Returns 200 (not 201)
- Reuses `existingCred.createdAt` instead of `now`

**Acceptance**: unit test seeds an existing credential, issues PUT with new token, asserts
200 + `createdAt` unchanged + new `iv`/`encryptedToken`.

## Acceptance Criteria

- [ ] GET route has unit coverage for empty, populated, cross-user, and response shape
- [ ] `ProjectAgentCredentialsSection` has behavioral tests for save/delete/retry + fallback copy
- [ ] Capability test covers `runtime.ts` `/agent-key` resolution with and without `projectId`
- [ ] DELETE 400 validation paths tested
- [ ] PUT update path tested with preserved `createdAt`

## References

- Rule 02 (quality gates): interactive element test requirement
- Rule 10 (e2e verification): capability tests mandatory for multi-component features
- Related: `tasks/backlog/2026-04-18-credentials-miniflare-integration-tests.md` (overlapping CRITICAL/HIGH findings)
- PR: https://github.com/raphaeltm/simple-agent-manager/pull/753
