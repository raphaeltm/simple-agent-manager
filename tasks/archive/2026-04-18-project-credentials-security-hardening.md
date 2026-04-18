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

- [x] CRITICAL #1: stale path returns no `refresh_token` (commit fd6c3ccc, codex-refresh-lock.ts lines 207-225; test `codex-refresh-lock.test.ts:245`)
- [x] HIGH #2: inactive project-scoped row no longer falls back to user-scoped row on refresh (commit fd6c3ccc, `getStoredCredential` lines 443-470; test `codex-refresh-lock.test.ts:408`)
- [x] HIGH #3: `project-auth.test.ts` replaced with behavioral test (commit fd6c3ccc, 192-line behavioral test file)
- [x] HIGH #4: `maskCredential()` helper applied at all sites with minimum-length guard (commit ad4648be at 5 sites; post-review commit applies `maskCredential()` at the 6th site `admin-platform-credentials.ts:226`; unit test `tests/unit/lib/credential-mask.test.ts` covers short/long/null/empty inputs)
- [x] MEDIUM #5: Codex refresh rate limit moved to DO `ctx.storage` (commit fd6c3ccc, `enforceRateLimit()` in DO; tests `codex-refresh-lock.test.ts:499-598`)
- [x] MEDIUM #6: scope validation active by default, unexpected scopes block with 502 (commit fd6c3ccc, `validateUpstreamScopes`; tests `codex-refresh-lock.test.ts:605-760`)
- [x] MEDIUM #7: project credential PUT has `rateLimitCredentialUpdate` (commit ad4648be middleware chain; behavioral 429 test added in `project-credentials.test.ts`)
- [x] MEDIUM #8: cross-user IDOR has defence-in-depth behavioral test (commit fd6c3ccc, `project-auth.test.ts:92-104`)
- [x] LOW #11: `CodexRefreshLock` unit tests cover stale/fresh/project/user paths (commit fd6c3ccc, 26 tests, 735-line test file)
- [x] All fixes verified on staging with two-account isolation test (Phase 6 staging verification — see PR description for evidence)

## Additional Findings Discovered During Implementation

These findings were surfaced during the Phase 5 specialist review cycle and fixed in the same PR (no deferrals per user directive):

### NEW HIGH — `getDecryptedAgentKey` inactive-fallback (runtime credential path)

**Discovered by**: security-auditor re-review (post-commit fd6c3ccc)
**Fixed in**: commit `d4b5d850`
**Summary**: The HIGH #2 class bug existed on the runtime credential delivery path as well (not only the `CodexRefreshLock` DO). `getDecryptedAgentKey` in `apps/api/src/routes/credentials.ts` was also falling back to the user-scoped row when the project-scoped row was inactive, enabling the same silent credential-rotation bug.
**Test**: `tests/unit/routes/project-credentials.test.ts:455` — "returns null (blocks user fallback) when project row exists but is inactive".

### NEW MEDIUM — Dead `checkCodexRefreshRateLimit` function + unused `CODEX_REFRESH` env entry

**Discovered by**: security-auditor re-review
**Fixed in**: commit `d4b5d850`
**Summary**: After the rate-limit relocation to DO storage (MEDIUM #5), the KV-based `checkCodexRefreshRateLimit` helper in `middleware/rate-limit.ts` and its associated `RATE_LIMIT_CODEX_REFRESH` entry in `DEFAULT_RATE_LIMITS` were orphaned. Dead code is load-bearing in security contexts — an operator reading the middleware file would assume KV is still the rate-limit store.

### NEW LOW — masking scope drift at admin platform credential route

**Discovered by**: task-completion-validator re-run
**Fixed in**: commit addressing admin-platform-credentials.ts:226
**Summary**: `apps/api/src/routes/admin-platform-credentials.ts:226` was a 6th `slice(-4)` site not listed in the original finding #4 scope. Admin-only and low risk (short platform credentials like service account keys would be fully exposed in the `maskedKey` response). Applied `maskCredential()` for consistency.

### Cloudflare-specialist — env var rename for consistency

**Discovered by**: cloudflare-specialist review
**Fixed in**: commit `05ff8d0e`
**Summary**: `RATE_LIMIT_CODEX_REFRESH` was renamed to `RATE_LIMIT_CODEX_REFRESH_PER_HOUR` across `env.ts`, `env.example`, documentation, and tests. The name makes the unit explicit and aligns with the rate-limit configuration convention used elsewhere (`RATE_LIMIT_CREDENTIAL_UPDATE`, `RATE_LIMIT_WORKSPACE_CREATE`).

### Cloudflare-specialist — atomic `DATABASE.batch()` for autoActivate deactivate+upsert

**Discovered by**: cloudflare-specialist review
**Fixed in**: commit `05ff8d0e`
**Summary**: The `autoActivate: true` path on both `PUT /api/credentials/agent` (user-scoped) and `PUT /api/projects/:id/credentials` (project-scoped) was using two separate drizzle statements. Under concurrency, a second write landing between the deactivate and upsert could leave two rows active. Replaced with raw `c.env.DATABASE.batch([deactivate, upsert])` for atomicity. Separate scope guards (`project_id IS NULL` for user-scoped; `project_id = ?` for project-scoped) ensure the two PUTs never cross-deactivate each other's rows.

## References

- Rule 02 (quality gates): source-contract tests prohibited
- Rule 25 (review merge gate): CRITICAL/HIGH should block merge — this post-merge rerun expands scope
- Rule 28 (new): `.claude/rules/28-credential-resolution-fallback-tests.md` — credential resolution fallback test requirements
- Post-mortem for this PR: `docs/notes/2026-04-18-project-credentials-security-hardening-postmortem.md`
- Related prior post-mortem: `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md`
- Source PR (that introduced findings): https://github.com/raphaeltm/simple-agent-manager/pull/753
