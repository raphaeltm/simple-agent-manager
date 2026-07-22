# Credential Resolution, Fallback, and Rotation Safety Tests

## When This Applies

This rule applies whenever code:

- Looks up a stored credential based on a `(userId, projectId?)` or similar scoping tuple
- Returns one credential by falling back across multiple possible rows (project → user → platform, or similar n-tier)
- Compares a caller-supplied credential against a stored one (OAuth refresh, API key rotation, password change)
- Accepts rotated credentials from an upstream provider (OAuth token refresh, SSO assertions, webhook signatures)

## Why This Rule Exists

PR #753 introduced per-project credential overrides with 3-tier resolution. The initial security review passed because the happy path (project-row-found, no-project-falls-through-to-user) was tested. A post-merge re-audit found 11 additional findings — most severely, a `CodexRefreshLock` stale-token branch that returned the live rotating refresh_token to any same-user caller who submitted a non-matching value.

The class of bug is **silent acceptance at credential trust boundaries.** Every finding was a path where the code accepted something it should have rejected, with no user-visible signal. See the retained incident lesson in this rule.

## Required Behavioral Tests

### 0. Provider / Dialect Identity Consistency

When a resolved consumer and the decrypted credential secret both name a
downstream provider, dialect, audience, or equivalent identity, tests MUST assert
that disagreement is rejected before the secret leaves the credential boundary.

Examples:

- A `compute:hetzner` consumer resolving a `cloud-provider` secret with
  `provider: "scaleway"` MUST throw before provider client construction.
- An agent/provider-dialect configuration that resolves to an incompatible
  secret dialect MUST throw before env vars, proxy config, or auth files are
  assembled.

The error should include both identities so the bad row is diagnosable without
logging the secret value.

### 1. Fallback Branch Coverage

For any function that returns a stored credential based on a scoping tuple, there MUST be a behavioral test for EACH of these branches:

| Branch | State | Expected outcome |
|--------|-------|------------------|
| Active scoped row exists | `(userId, projectId)` row found with `is_active=1` | Use the scoped row; do not query higher tiers |
| Scoped row exists but inactive | `(userId, projectId)` row found with `is_active=0` | **Reject the lookup.** Do NOT fall back to higher tier. |
| No scoped row, active user-tier row | No project row; user row exists and active | Fall back to user-tier row |
| No row at any tier | Nothing matches | Return null / reject |

The "inactive scoped row blocks fallback" branch is the most commonly missed and the most dangerous. An inactive row represents an explicit user deactivation; falling back to a higher-tier row silently rotates a credential the user did not intend to rotate.

### 2. Stale-Credential Response Shape

Any function that compares a caller-supplied credential against a stored one MUST have a test asserting that the response on mismatch:

- Does NOT return the stored rotating credential (refresh_token, current API key, session token)
- MAY return a non-rotating short-lived derivative (access_token) if needed for concurrent-caller UX
- Returns enough information that the caller can distinguish "mismatch" from "credential not found"

### 3. Rotation Scope Validation

**First classify the upstream.** The correct failure behavior depends on whether
rejecting the rotation can actually preserve the prior credential:

**(a) Re-usable upstream** — rejecting leaves the old credential valid (webhook
signature rotation, non-rotating API-key exchange). Tests MUST assert:

- The validation defaults to a conservative allowlist when the config env var is unset (not: defaults to disabled)
- An unexpected scope / signature-algorithm / audience causes the request to be REJECTED (502 or equivalent), not merely logged
- Rejected rotations MUST NOT persist the new credential (the old credential remains valid)
- The env-var escape hatch (`EXPECTED_SCOPES=""`) is an explicit opt-out — absent env var ≠ disabled

**(b) One-time-use rotating upstream** — the exchange CONSUMES the old credential
before the response (and its scopes) is visible (OpenAI Codex refresh tokens,
any OAuth provider with refresh-token rotation + reuse detection). Here
"reject-no-persist" is FORBIDDEN: the old credential is already dead, so
discarding the response permanently strands the credential family. This exact
mistake (CodexRefreshLock scope gate, PR #1412) burned every production Codex
credential seeded after 2026-07-01 on its first refresh — see
`tasks/archive/2026-07-22-fix-codex-refresh-scope-gate-family-burn.md`. Tests MUST assert:

- A completed upstream rotation is ALWAYS persisted (all synced representations,
  per rule 44), regardless of validation outcome — including when an
  abort/timeout signal fires between upstream success and the write
- Validation anomalies produce a DURABLE alert that survives log sampling
  (e.g. `platform_errors`), not only a log line
- The allowlist default matches what the provider's CURRENT login flow actually
  grants (verify against the provider client's source, not assumptions)
- The env-var escape hatch (`EXPECTED_SCOPES=""`) still disables detection
- No token material appears in the persisted diagnostic

### 4. Rate Limit on Credential Rotation Endpoints

Credential rotation endpoints (OAuth refresh, key rotation) MUST have:

- A per-principal (userId or workspaceId) rate limit
- The limit state MUST be atomic — DO storage, database row-level locks, or an equivalent. KV read-modify-write is NOT acceptable for rate limits guarding credential rotation.
- A behavioral test that exercises "at-limit rejection" AND "window rollover resets counter"

## Prohibited Patterns

1. **Warn-only rotation validation.** `log.warn('unexpected scope') ; storeNewTokens(...)` silently accepts escalations. Either block or don't validate.

2. **Source-contract tests on credential middleware.** `expect(file.toContain('requireOwnedProject'))` proves code is *present*, not that it *enforces identity*. Rule 02 already bans this — call it out explicitly for auth code.

3. **Tautological IDOR tests.** Mocking `getUserId` to always return the same value and then asserting "cross-user writes rejected" tests "row-not-found handling," not "cross-user identity check." Tests MUST construct scenarios where the DB returns a row whose `userId` does NOT match the caller's.

4. **Defence-in-depth absent.** The query-layer filter (`WHERE userId = ?`) is one line of defence; the middleware MUST also check `row.userId === userId` post-query. An ORM bug, a refactor typo, or a stub in a test harness must not be able to return the wrong row without tripping an assertion.

## Quick Compliance Check

Before merging any PR that touches credential resolution, rotation, or comparison:

- [ ] Every fallback branch has a behavioral test (active-scoped, inactive-scoped, no-scoped, no-row-at-all)
- [ ] Provider/dialect identity mismatches are rejected before a credential is assembled or a downstream client is constructed
- [ ] Stale/mismatch responses are asserted to OMIT the rotating credential
- [ ] Rotation validation defaults to a conservative allowlist (not disabled)
- [ ] Rotation validation BLOCKS on failure, not warns
- [ ] Rate limit on rotation endpoints uses an atomic primitive (DO storage, DB lock), not KV
- [ ] At least one test returns a mismatched-user row from the DB stub and asserts the middleware still throws 404 (defence-in-depth)
- [ ] No source-contract tests on auth middleware

## References

- Post-mortem: the retained incident lesson in this rule
- Rule 02: source-contract tests banned
- Rule 11: identity validation at system boundaries
- Rule 25: review merge gate — CRITICAL/HIGH findings block merge
