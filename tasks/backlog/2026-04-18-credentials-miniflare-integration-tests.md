# Miniflare + real D1 integration tests for project-scoped credentials

**Created**: 2026-04-18
**Priority**: HIGH
**Source**: test-engineer review of PR `sam/project-credential-overrides`

## Problem

The project-credential-overrides PR ships with 14 unit tests that exercise the
route code paths but **cannot verify the actual SQL WHERE predicates** that
enforce scope isolation. This is a structural limitation of the current mock:

```typescript
db.where = vi.fn().mockReturnValue(db);
```

Every chained Drizzle method returns the same mock object, so the test cannot
introspect the argument passed to `.where()`. Tests like "returns project-scoped
credential when projectId is provided" pass even if the code mistakenly queried
user-scoped rows — the mock simply resolves whatever the test queued, regardless
of which filter was constructed.

The test-engineer flagged this as CRITICAL because the **core security boundary
of this feature is the query layer** (in addition to ownership check at the
middleware layer). A SQL predicate regression — e.g., dropping
`isNull(projectId)` from the user-scoped lookup — would leak project overrides
into user-scoped results (or vice versa) without failing any unit test.

## What This Task Delivers

Replace the mocked-Drizzle unit tests (or add alongside them) with a Miniflare
harness that uses a real D1 database seeded with known rows, then exercises the
routes end-to-end:

- Create two users (u1, u2) with two projects each
- Seed credentials at all three scopes:
  - User-scoped (`project_id IS NULL`) for u1
  - Project-scoped for u1's project p1
  - Project-scoped for u1's project p2 (to verify cross-project isolation)
  - User-scoped for u2 (to verify cross-user isolation)
- Assert each HTTP route returns exactly the rows for the active
  user × project × scope combination

## Scope

- `apps/api/tests/integration/project-credentials.integration.test.ts` (new)
- Harness setup (`apps/api/tests/helpers/miniflare-d1.ts`) if not already present
- Optionally: port the existing `project-credentials.test.ts` unit tests, or
  keep them as cheap smoke checks and rely on integration tests for correctness

## Findings to Address (test-engineer review)

### CRITICAL #1 — Cannot verify WHERE predicates in getDecryptedAgentKey

The resolution order tests (`project > user > platform`) queue return values on
`mockDB.limit`, but never assert which `isNull(projectId)` / `eq(projectId, X)`
expressions were actually constructed. A bug that flipped the predicate would
not fail.

**Acceptance**: integration test submits real seeded rows and calls
`getDecryptedAgentKey(db, userId, 'claude-code', key, projectId)` directly;
asserts the returned row's `id` is the expected one for each scope.

### CRITICAL #2 — Cannot verify cross-user isolation at query layer

The route tests use middleware-level mock short-circuits (`mockDB.limit`
resolves to `[]` for "not owned"). Real cross-user isolation requires the
query itself to never return another user's rows even if ownership middleware
is bypassed.

**Acceptance**: integration test seeds u1 + u2 credentials, authenticates as
u1, calls GET/PUT/DELETE on u2's project IDs, asserts 404 AND asserts the
backing query returned zero rows belonging to u2 regardless of the HTTP
outcome.

### HIGH #5 — PUT autoActivate sweep does not verify project-only deactivation

Test "when autoActivate is true, only deactivates project-scoped rows" just
asserts `mockDB.update` was called. It cannot verify the sweep UPDATE's WHERE
clause actually included `projectId = X` (vs deactivating user rows too).

**Acceptance**: integration test seeds 1 user-scoped + 1 project-scoped row,
saves a new project credential with autoActivate, asserts only the
project-scoped row flipped `isActive=false` (user-scoped row unchanged).

### HIGH #6 — DELETE does not verify project-only deletion

Similar to #5 — `mockDB.returning.mockResolvedValueOnce([{id}])` does not verify
the delete only targeted the project-scoped row.

**Acceptance**: integration test seeds user-scoped + project-scoped rows for
the same (userId, agentType, credentialKind), calls DELETE, asserts only the
project-scoped row is gone.

### HIGH #7 — Codex refresh DO routing is not verified for project scope

`codex-refresh.test.ts` now asserts `doRequestBody.projectId` is forwarded, but
the CodexRefreshLock DO's use of projectId (to look up the right credential
row) is not exercised end-to-end.

**Acceptance**: integration test spawns CodexRefreshLock DO with a real DB,
posts a refresh request with projectId, asserts the credential updated is the
project-scoped one (not a user-scoped one with the same userId).

## Acceptance Criteria

- [ ] Miniflare harness seeds users, projects, and credentials deterministically
- [ ] Integration test covers all three scopes for `getDecryptedAgentKey`
- [ ] Integration test covers cross-user + cross-project isolation for
      GET/PUT/DELETE routes
- [ ] Integration test verifies PUT autoActivate sweep only touches
      project-scoped rows
- [ ] Integration test verifies DELETE only removes project-scoped rows
- [ ] Integration test verifies CodexRefreshLock routes to the correct
      credential row based on projectId

## References

- Source review: `test-engineer` on PR `sam/project-credential-overrides`
- Rule 02 (quality gates): "Source-contract tests are NOT valid behavioral tests"
- Rule 23 (cross-boundary contract tests)
- Existing Miniflare integration harness: `apps/api/tests/integration/` (if present)
