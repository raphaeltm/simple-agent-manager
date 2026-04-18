# Security hardening for project credential overrides (PR #753)

**Created**: 2026-04-18
**Priority**: CRITICAL (contains 1 CRITICAL + 3 HIGH findings)
**Source**: Post-merge security-auditor rerun on PR #753 (`sam/project-credential-overrides`)

## Context

PR #753 was merged after passing Phase 5 specialist review (security-auditor PASS at the time).
This post-merge second-look audit expanded scope and found additional concerns that were not
caught in the initial review. The merge was correctly gated per rule 25; this backlog captures
the follow-up work.

**No active exploit is claimed for the CRITICAL finding** — the scenario requires either a
prior workspace compromise or a legitimate intent to recover from a race. However, the design
should be tightened.

## Findings

### CRITICAL #1 — Codex refresh stale-token path returns live `refresh_token`

**Location**: `apps/api/src/durable-objects/codex-refresh-lock.ts:142-152`

When the DO's stored refresh token does not match the caller's submitted refresh token (the
"stale — another workspace rotated" branch), the response body includes the current live
`access_token`, `refresh_token`, and `id_token`. The caller authenticates via a workspace-scoped
JWT (so the caller is confirmed to be a workspace owned by the same user), but the caller did
not need to *possess* a valid current refresh token to retrieve the new one.

**Risk**: Any workspace owned by the same user that can reach the endpoint and submit any
non-matching refresh token value can obtain the current live tokens. The DO keying by `userId`
bounds the blast radius to the user's own tokens; project-scope is respected via the `projectId`
passed from the verified workspace row. The concern is that returning a live `refresh_token` to
a caller who did not already hold it undermines the rotation model.

**Fix**: In the stale branch, return only `access_token` (short-lived) OR omit the response body
entirely and require the caller to re-authenticate via the standard OAuth flow. Do not return
`refresh_token` unless the caller proves possession of a recently-valid value.

**Verification test**: Given stored tokens `{refresh: 'R2'}`, POST with `refresh_token: 'R-old'` —
assert response does NOT contain `R2` in `refresh_token` field.

### HIGH #2 — Scope contamination in `getStoredCredential` fallback

**Location**: `apps/api/src/durable-objects/codex-refresh-lock.ts:303-338`

If a project-scoped credential row exists for `(userId, projectId)` but is `is_active = 0`
(e.g., deactivated by a recent `autoActivate: true` save), `getStoredCredential` returns the
user-scoped row instead. Token rotation then updates the user-scoped row, affecting *all*
other projects inheriting it.

**Fix**: If `projectId` is supplied AND any row exists for `(userId, projectId)` (active or
inactive), do NOT fall back to the user-scoped row. Either require an active project-scoped
row or reject the refresh with 409 so the workspace re-obtains credentials via the normal flow.

**Verification test**: Seed user-scoped `R_USER` + inactive project-scoped `R_PROJ_INACTIVE`.
Refresh with `projectId` set. Assert the user-scoped row is NOT updated.

### HIGH #3 — `project-auth.test.ts` is a prohibited source-contract test

**Location**: `apps/api/tests/unit/middleware/project-auth.test.ts:1-15`

The test reads `project-auth.ts` as a string and checks `file.toContain('requireOwnedProject')`.
Per `.claude/rules/02-quality-gates.md`, source-contract tests are prohibited for interactive
code. `requireOwnedProject` is the sole IDOR defense for project credential routes and has no
behavioral coverage.

**Fix**: Replace with a behavioral test that:
1. Constructs a request context with userId `u1`
2. Mocks a DB that returns a project row with `userId: 'u2'` for the queried `projectId`
3. Asserts `requireOwnedProject` throws 404 (not lets the request through)

### HIGH #4 — Masked-key `slice(-4)` leaks short credentials

**Location**:
- `apps/api/src/routes/projects/credentials.ts:69` (GET list, from plaintext)
- `apps/api/src/routes/projects/credentials.ts:163` (PUT save, from raw input)
- `apps/api/src/routes/credentials.ts:251`
- `apps/api/src/routes/credentials.ts:361`
- `apps/api/src/routes/credentials.ts:392`

For credentials shorter than 4 characters, `slice(-4)` returns the full value. Real-world API
keys are long so exploitability is low, but the code smell should be fixed consistently.

**Fix**: Add a helper `maskCredential(plaintext: string): string` that returns `'...[set]'` when
`plaintext.length <= 8` (i.e., 2x the slice window) and `...${plaintext.slice(-4)}` otherwise.
Apply at all 5 sites.

Also standardize the masking source — always derive from decrypted plaintext, not raw input at
save time (minor consistency fix).

### MEDIUM #5 — Codex refresh rate limit is KV-based (non-atomic)

**Location**: `apps/api/src/middleware/rate-limit.ts:99-131`, applied to codex-refresh route

KV read-modify-write can over-count under concurrency. For the Codex refresh endpoint, this
could allow an attacker with a stolen workspace callback token to exceed the 30/hour cap and
trigger OpenAI-side throttling or token invalidation.

**Fix**: Move rate-limit counter into the existing `CodexRefreshLock` DO (already keyed per
userId). DO state is strongly consistent, giving atomic increments.

### MEDIUM #6 — `validateUpstreamScopes` only warns, scope validation disabled by default

**Location**: `apps/api/src/durable-objects/codex-refresh-lock.ts:261-295`

Default configuration (no `CODEX_EXPECTED_SCOPES`) skips scope validation entirely. Even when
configured, a mismatch only logs `log.warn` and does not block storage/return of the token.

**Fix**: (a) Add a default `CODEX_EXPECTED_SCOPES` value derived from known OAuth flow scopes.
(b) On unexpected scope, refuse to store and return 502 to the caller. (c) Document the env var
in `env-reference`.

### MEDIUM #7 — Project credential PUT route has no rate-limit middleware

**Location**: `apps/api/src/routes/projects/credentials.ts:98`

User-scoped `/api/credentials/agent` PUT applies `rateLimitCredentialUpdate`. The project-scoped
PUT route at `/api/projects/:id/credentials` does not. An authenticated user could spam
encrypt+write operations.

**Fix**: Apply `rateLimitCredentialUpdate` to the project-scoped PUT route, matching the
user-scoped protection.

### MEDIUM #8 — Cross-user test uses fixed `getUserId` mock

**Location**: `apps/api/tests/unit/routes/project-credentials.test.ts:20-24`

`getUserId` always returns `'test-user-id'`. Cross-user "rejects write" tests actually exercise
"project-not-found" (empty DB result), not "project-belongs-to-other-user" (row with mismatched
userId). Overlaps with `2026-04-18-credentials-miniflare-integration-tests.md` CRITICAL #2 but
can also be addressed at unit level.

**Fix**: Either (a) use miniflare integration tests (preferred, already tracked elsewhere), or
(b) add a unit test that mocks the DB to return a project row with `userId: 'other-user'` and
verifies `requireOwnedProject` still throws 404.

### LOW #9 — Masked-key source inconsistency (save vs list)

**Location**: `apps/api/src/routes/projects/credentials.ts:163` vs `:69`

Save derives mask from raw input; list derives from decrypted plaintext. For API keys these are
identical; for auth.json blobs they differ meaninglessly. Consolidate both paths to use
decrypted plaintext via the shared helper introduced in HIGH #4.

### LOW #10 — No rate-limit on project credential PUT

(Duplicate of MEDIUM #7 — treat as single item.)

### LOW #11 — No `CodexRefreshLock` behavioral tests

**Location**: `apps/api/tests/` (no file exists)

The DO has no unit tests covering: stale-token path, fresh-token path, project vs user fallback.
Once CRITICAL #1 and HIGH #2 fixes land, add regression tests for each path.

## Acceptance Criteria

- [ ] CRITICAL #1: stale path returns no `refresh_token` (and ideally no `access_token` either)
- [ ] HIGH #2: inactive project-scoped row no longer falls back to user-scoped row on refresh
- [ ] HIGH #3: `project-auth.test.ts` replaced with behavioral test
- [ ] HIGH #4: `maskCredential()` helper applied at all 5 sites with minimum-length guard
- [ ] MEDIUM #5: Codex refresh rate limit moved to DO state
- [ ] MEDIUM #6: scope validation active by default, unexpected scopes block
- [ ] MEDIUM #7: project credential PUT has `rateLimitCredentialUpdate`
- [ ] MEDIUM #8: cross-user IDOR has behavioral test (unit or integration)
- [ ] LOW #11: `CodexRefreshLock` unit tests cover stale/fresh/project/user paths
- [ ] All fixes verified on staging with two-account isolation test

## References

- Rule 02 (quality gates): source-contract tests prohibited
- Rule 25 (review merge gate): CRITICAL/HIGH should block merge — this post-merge rerun expands scope
- Post-mortem to cite when fixing: `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`
- Related backlog: `tasks/backlog/2026-04-18-credentials-miniflare-integration-tests.md`
- Related backlog: `tasks/backlog/2026-04-18-project-credentials-missing-tests.md`
- Source PR: https://github.com/raphaeltm/simple-agent-manager/pull/753
