# Fix production Codex OAuth refresh 429 (dual-write desync after composable-credentials migration)

- SAM Task: 01KWBRMNS82VP3XRCYQ6F72FJD
- SAM Idea: 01KWBRKQHR5SPVKG7Q09ZFJQ5Y
- Output branch: sam/fix-production-codex-oauth-01kwbr

## Problem Statement

Production Codex sessions hit `429 Too Many Requests` from the SAM Codex refresh
proxy. Root cause is a **dual-write desync** introduced by the composable-credentials
migration (#1315 2026-06-14, #1332 2026-06-16):

The `CodexRefreshLock` Durable Object rotates the Codex OAuth `refresh_token` and
persists it ONLY to the legacy `credentials` table — it never mirrors the rotated
token into the new `cc_credentials` table. Workspaces seed `~/.codex/auth.json`
from the `cc_credentials` snapshot (frozen at backfill time). So:

1. DO rotates refresh_token, writes legacy `credentials` only.
2. `cc_credentials` codex row stays frozen at backfill time.
3. A fresh workspace seeds `auth.json` from the stale `cc_credentials` row.
4. The stale refresh_token no longer matches the DO's rotated token.
5. Once the grace window (default 5 min) expires, the stale path returns an
   expired access_token with **no** rotation.
6. Codex gets 401 from OpenAI → immediately re-refreshes → loop.
7. The loop exceeds the rate limit (default 30/hr) → 429.

### Production evidence
- Legacy credential `01KR9EAKXA1BPQQT8B3VCZQZDW` (owner `4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx`)
  `updated_at = 2026-06-20 02:07:09` — keeps rotating.
- Matching `cc_credentials` codex copy `updated_at = 2026-06-14 13:27:02` — frozen
  at backfill, never synced.

## Research Findings

### Core file
`apps/api/src/durable-objects/codex-refresh-lock.ts`
- Legacy persist at ~lines 391-399: encrypts `updatedAuthJson`, then
  `UPDATE credentials SET encrypted_token=?, iv=?, updated_at=datetime('now') WHERE id=?`.
- `enforceRateLimit()` (def ~414-434) keys a single `'rate-limit'` storage key and is
  called BEFORE the grace/stale/match branches (~lines 193-209) — so cached responses
  consume budget, and all of a user's credentials share one bucket.
- `getStoredCredential(userId, projectId)` (~594-643) returns `{ id, encryptedToken, iv }`
  but NOT the credential's scope projectId. The sync call needs that scope.

### Sync function
`apps/api/src/services/composable-credentials/agent-sync.ts`
```
syncActiveAgentCredentialSecret(database, {
  userId, projectId?, agentType, credentialKind, encryptedToken, iv
}): Promise<number>
```
UPDATEs the active `cc_credentials` row reachable via active cfg+att for that
owner/agent/scope. Kind mapped by `ccKindForAgentCredential`:
`(openai-codex, oauth-token) -> auth-json`. Project predicate is
`att.project_id = ?` when projectId set, else `att.project_id IS NULL`.

### Correct mirror pattern to follow
`apps/api/src/routes/workspaces/runtime.ts` (~lines 1060-1078): after
`UPDATE credentials`, calls `syncActiveAgentCredentialSecret` with the credential
row's own `projectId` (NOT the workspace's). This is exactly what the DO is missing.

### Relevant rules / lessons
- `.claude/rules/28-credential-resolution-fallback-tests.md` — fallback branch tests,
  stale-credential response must omit rotating token, atomic rate limit on rotation.
- `.claude/rules/35-vertical-slice-testing.md` — realistic-state slice test.
- `.claude/rules/13` + `.claude/rules/30` — staging E2E hard gate, never ship broken.
- `.claude/rules/02` — regression tests + post-mortem + process fix for bug fixes.
- Constitution Principle XI — rate-limit window/limit and sentinel IDs env-configurable.

## Implementation Checklist

- [ ] **Change #1 (core fix):** In `codex-refresh-lock.ts`, immediately after the legacy
  `UPDATE credentials` persist, call `syncActiveAgentCredentialSecret(this.env.DATABASE, { userId, projectId: credential.scopeProjectId, agentType: 'openai-codex', credentialKind: 'oauth-token', encryptedToken: ciphertext, iv })` reusing the same `ciphertext`/`iv`.
  Add the import from `../services/composable-credentials/agent-sync`.
- [ ] **Extend getStoredCredential** to also return `scopeProjectId: string | null`
  (projectId when active project row matched; null on the user-scoped fallback).
- [ ] **Change #2:** Key `enforceRateLimit()` by credential ID — storage key
  `` `rate-limit:${credentialId}` `` and accept `credentialId` param.
- [ ] **Change #3:** Move the `enforceRateLimit()` call to AFTER the grace/stale/match
  branches (just before the upstream OpenAI fetch) so cached/stale/grace responses
  do NOT consume rate-limit budget.
- [ ] **Change #4 (invariant):** Keep the stale-credential return behavior unchanged —
  stale path still returns `{ accessToken, idToken, stale: true }` (NO refresh_token).
- [ ] **Tests — dual-write:** after rotation, BOTH legacy `credentials` AND
  `cc_credentials` rows updated, for user-scoped AND project-scoped credentials.
- [ ] **Tests — vertical slice regression:** a fresh workspace's seeded
  `~/.codex/auth.json` reflects the latest rotated token (cc_credentials in sync).
- [ ] **Tests — rate limit:** keyed by credential ID (distinct credentials have
  distinct buckets); cached/grace/stale responses don't consume budget; only real
  OpenAI calls count; at-limit rejection (429 + Retry-After); window rollover resets.
- [ ] **Post-mortem + process fix:** record post-mortem (class: dual-write desync after
  storage migration — new write path not updated to sync cc_credentials) and add a
  process-fix rule so future migrations enumerate every writer of a migrated table.

## Acceptance Criteria

- [ ] After a Codex refresh rotation, the matching `cc_credentials` row's
  `encrypted_token`/`iv`/`updated_at` are updated in the same DO operation as the
  legacy `credentials` row (verified by a behavioral test for both scopes).
- [ ] A freshly provisioned workspace seeds `auth.json` with the rotated token, not a
  stale backfill token (verified by a vertical-slice regression test).
- [ ] Rate limit is per-credential and only consumed by real OpenAI refreshes
  (verified by tests for keying, cached-no-consume, at-limit, and rollover).
- [ ] Stale-credential responses still omit the rotating refresh_token.
- [ ] No decrypted token material is ever logged.
- [ ] Rate-limit window/limit remain env-configurable with `Default*` constants.
- [ ] Real Codex refresh exercised E2E on staging before merge (HARD GATE).

## References
- SAM idea 01KWBRKQHR5SPVKG7Q09ZFJQ5Y
- `.claude/rules/02`, `13`, `28`, `30`, `35`, Constitution Principle XI
- PRs #1315, #1332 (composable-credentials migration)
