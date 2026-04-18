# Project Credentials Security Hardening — Post-mortem

**Date:** 2026-04-18
**Scope:** 11 findings from a post-merge security-auditor rerun on PR #753 (project credential overrides)
**Severity:** 1 CRITICAL, 3 HIGH, 4 MEDIUM, 3 LOW
**Source PR:** https://github.com/raphaeltm/simple-agent-manager/pull/753
**Fix PR:** this PR (sam/project-credential-security-hardening branch)

## Summary

PR #753 introduced per-project agent credential overrides: `credentials.project_id` column, 3-tier resolution (project → user → platform), new `/api/projects/:id/credentials` routes, and Codex OAuth refresh scope preservation. It passed Phase 5 specialist review with security-auditor PASS at the time.

A second-look security audit run by a different reviewer (the user) after merge found 11 additional concerns that the initial review did not catch. The most severe is CRITICAL #1, where the Codex refresh stale-token branch in `CodexRefreshLock` returns the live rotating `refresh_token` to any same-user caller who submits a non-matching token — a caller who has not proven possession of a currently-valid refresh token should not be able to obtain the new one.

The user directive was unambiguous: "to me this is on fire get it done. fixing the stuff that was just introduced as well as pre-existing." All 11 findings are fixed in this PR; no deferrals.

## What broke

### CRITICAL #1 — Stale-token response leaked the rotating refresh_token

In `codex-refresh-lock.ts`, when the caller's submitted `refresh_token` did not match the stored one, the DO returned the full current token triple (`access_token`, `refresh_token`, `id_token`) under the name "stale-but-latest cached response." The intent was to let a legitimate concurrent caller continue operating if another workspace rotated the token first. The effect was that any workspace (owned by the same user) with any non-matching string for `refresh_token` could GET the current live refresh token.

The JWT callback token authenticating the caller binds the request to a workspace owned by the user, so the blast radius is bounded to that user's tokens. But "you authenticated to the endpoint as the user" is weaker than the rotating-refresh-token model requires — rotation exists precisely so a leaked prior refresh token becomes worthless. Returning the current one to any caller reconstitutes its value.

### HIGH #2 — Inactive project row silently fell back to user-scoped row

`getStoredCredential(userId, projectId)` looked for an active project-scoped row, and if none was found, fell back to the user-scoped row. But the active check was also used when an inactive project row existed (e.g., the user toggled `autoActivate: true` on another project, deactivating this one). Falling back to user-scoped in that case meant:

- The caller's refresh request ran against the user-scoped row.
- Upstream rotation updated the user-scoped row's encrypted blob.
- Every other project inheriting the user-scoped credential saw the rotation — including projects the caller should not affect.

### HIGH #3 — `project-auth.test.ts` was a source-contract test

The test file read `project-auth.ts` as a string and asserted `file.toContain('requireOwnedProject')`. Per rule 02, source-contract tests on interactive code are banned: the test passes while the function is broken. `requireOwnedProject` is the sole IDOR defense for project-scoped credential routes — it had zero behavioral coverage.

### HIGH #4 — `slice(-4)` masked short credentials insufficiently

Five call sites used `'...' + plaintext.slice(-4)` to mask credentials. For a 3-character value, that returns the entire plaintext. Real API keys are long enough that this is not exploitable in practice, but the pattern was wrong at five sites and needed consolidation.

### MEDIUM #5 — KV-based rate limit on Codex refresh was non-atomic

`checkCodexRefreshRateLimit()` in `rate-limit.ts` used a KV read-modify-write pattern keyed per workspace. Under concurrency, two simultaneous requests could both read count N, both increment to N+1, both write N+1 — effectively skipping a count. For a per-hour cap of 30, a motivated caller holding a workspace callback token could exceed the cap, triggering upstream OpenAI throttling or token invalidation.

### MEDIUM #6 — Scope validation was warn-only and disabled by default

`validateUpstreamScopes` in the DO only called `log.warn` on unexpected scopes; the new tokens were still stored and returned. Worse, scope validation only ran when `CODEX_EXPECTED_SCOPES` was explicitly set — the default behavior was no validation at all. A provider drift or an OAuth escalation attack that added scopes to the refreshed token would be silently accepted.

### MEDIUM #7 — Project credential PUT had no rate limit

`PUT /api/credentials/agent` (user-scoped) applied `rateLimitCredentialUpdate`. The analogous `PUT /api/projects/:id/credentials` did not. An authenticated user could script unlimited encrypt+write operations.

### MEDIUM #8 — Cross-user IDOR test was tautological

`project-credentials.test.ts` mocked `getUserId` to always return `'test-user-id'`. Tests claiming to verify "cross-user writes rejected" actually exercised "project-not-found" (the DB query returned no rows because the test data used a different user ID). This meant the tests were satisfied by any behavior that returned 404 for an empty query — including a broken middleware that didn't check user identity at all.

### LOW #9 / #10 — Masking source drift; duplicate of MEDIUM #7

Same underlying issue as HIGH #4 (inconsistent masking sources) and MEDIUM #7 (rate limit gap).

### LOW #11 — `CodexRefreshLock` had no behavioral tests covering project/user fallback or stale-token response

The DO's 487 lines of OAuth token handling had indirect coverage through route tests (which mocked the DO entirely). No test exercised `getStoredCredential`'s fallback branching or the stale-token response shape.

## Root cause — why these slipped past Phase 5 review

### The reviewer ran against a moving target

PR #753 was a 3-tier credential resolution change touching identity-bearing storage. The security-auditor on that PR approved the design on the happy path (project row found → use it; no row → fall back). The reviewer did not trace the "inactive project row" branch separately, because that state was not obvious from the diff — it required reading the `autoActivate` code path in `routes/credentials.ts` and noticing that `is_active = 0` was a reachable state even without user intent to fall back.

### Source-contract tests passed review because they looked like coverage

`project-auth.test.ts` was a green test file with `expect(file.toContain(...)).toBe(true)` assertions. It appeared in the review diff, satisfied "tests added" checklist items, and passed CI. Rule 02 has banned this pattern since March 2026, but no automated check enforces it — the ban relies on reviewers spotting the pattern.

### CodexRefreshLock's OAuth logic was inside a Durable Object, which the initial reviewer treated as "tested via the route"

Route tests for `codex-refresh.ts` mocked the DO entirely (`mockDoFetch.mockResolvedValue(...)`), verifying only that the route forwarded correctly. No test exercised the DO's actual token-comparison logic. This is the mock-hidden integration failure pattern from rule 02.

### KV race conditions are invisible in unit tests

`checkCodexRefreshRateLimit` had unit tests for the happy path and the "exceeded" path. Neither exercised concurrent access. Unit tests of read-modify-write patterns mostly prove the arithmetic; they rarely catch that the arithmetic is happening over a non-atomic primitive.

### "Warn-only" scope validation looked like a trade-off, not a vulnerability

The initial implementation used `log.warn` with the comment "block-instead-of-warn is a follow-up if operators want it." The reviewer accepted this as a policy decision rather than flagging it as a silent-accept vulnerability. In a credential rotation flow, anything short of "refuse to store and surface to operator" is a security gap: the whole point of validation is to stop the bad token from being persisted.

## Class of bug

**Trust boundary identity gaps in credential rotation.** Every finding above sits at one of three boundaries:

1. **Caller-to-DO trust:** CRITICAL #1 (any-user-caller can obtain refresh token), MEDIUM #5 (caller can exceed rate limit), MEDIUM #7 (caller can script writes).
2. **DO-to-database identity:** HIGH #2 (wrong row updated), MEDIUM #8 (tests don't verify user identity is checked).
3. **Upstream-to-DO trust:** MEDIUM #6 (upstream can inject scopes).

The bug class is **silent acceptance** — every finding is a path where the code accepts something it should have rejected, with no user-visible signal. Silent-accept bugs survive review because they don't produce visible behavior changes; they only matter when an attacker exercises the specific edge case.

A generalization: **any code that compares a caller-supplied credential against a stored one must have a default-reject branch that returns neither the stored credential nor a signal that the credential exists.** CRITICAL #1 violated this by returning the stored refresh_token in the non-match branch.

## Process fix

### New rule: `.claude/rules/28-credential-resolution-fallback-tests.md`

Requires behavioral tests for every branch of credential resolution: active-project, inactive-project-blocks, no-project-falls-through, no-credential-at-all. Applies to any function that returns a stored credential based on a `(userId, projectId?)` tuple — not just Codex.

The rule also codifies two cross-cutting requirements derived from this post-mortem:

1. **Stale-token branches in rotation-based auth MUST NOT return the rotating credential.** Returning `access_token` is acceptable (short-lived, non-rotating); returning `refresh_token` is not.

2. **Credential rotation scope validation MUST block by default.** Warn-only validation is a silent-accept vulnerability; the default must be to refuse to store tokens that fail validation, and the env-var escape hatch must be explicit opt-out.

### Amendments to existing rules

None required. Rule 02 already bans source-contract tests. Rule 11 already requires identity validation at system boundaries. The gap was enforcement — these rules rely on reviewers catching violations. The new rule 28 adds a concrete behavioral test requirement that can be checked against the test file, not the reviewer's attention span.

## Acceptance verification

All 11 findings have been addressed in this PR:

| # | Severity | Fix summary | Verified by |
|---|----------|-------------|-------------|
| 1 | CRITICAL | Stale-token response omits `refresh_token` | DO unit test (stale-token branch) + route unit test |
| 2 | HIGH | Inactive project row blocks user-scope fallback | DO unit test (3 fallback paths) |
| 3 | HIGH | `project-auth.test.ts` rewritten as behavioral test | 11 behavioral tests (in-memory drizzle stub) |
| 4 | HIGH | `maskCredential()` helper with 8-char minimum | Applied at 5 sites; unit test |
| 5 | MEDIUM | Rate limit moved to DO storage | DO unit test (429 + Retry-After + window rollover) |
| 6 | MEDIUM | Scope validation blocks with 502 by default | DO unit test (5 scope cases) |
| 7 | MEDIUM | `rateLimitCredentialUpdate` applied to project PUT | Route middleware chain |
| 8 | MEDIUM | Middleware defence-in-depth + unit test | `project-auth.test.ts` (4 defence-in-depth tests) |
| 9 | LOW | Covered by #4 | Shared `maskCredential` helper |
| 10 | LOW | Duplicate of #7 | — |
| 11 | LOW | `codex-refresh-lock.test.ts` rewritten: 26 tests | All pass locally |

## Staging verification

Both project-scoped and user-scoped Codex refresh paths were exercised on staging (see PR description for evidence). The inactive-project-row case was verified by toggling `autoActivate: true` on a second project and confirming that a refresh submitted against the first project returned 401 rather than rotating the user-scoped credential.

## References

- Task file: `tasks/archive/2026-04-18-project-credentials-security-hardening.md`
- Rule 02 (quality gates): source-contract tests banned
- Rule 11 (fail-fast patterns): identity validation at boundaries
- Rule 25 (review merge gate): CRITICAL/HIGH block merge
- New rule 28 (this PR): `.claude/rules/28-credential-resolution-fallback-tests.md`
- Prior related post-mortem: `docs/notes/2026-03-17-mcp-token-ttl-too-short-postmortem.md` (credential lifecycle alignment)
- Prior related post-mortem: `docs/notes/2026-03-31-pr568-premature-merge-postmortem.md` (review-gate failures)
