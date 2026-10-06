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

- [x] **Change #1 (core fix):** In `codex-refresh-lock.ts`, immediately after the legacy
  `UPDATE credentials` persist, call `syncActiveAgentCredentialSecret(this.env.DATABASE, { userId, projectId: credential.scopeProjectId, agentType: 'openai-codex', credentialKind: 'oauth-token', encryptedToken: ciphertext, iv })` reusing the same `ciphertext`/`iv`.
  Add the import from `../services/composable-credentials/agent-sync`.
- [x] **Extend getStoredCredential** to also return `scopeProjectId: string | null`
  (projectId when active project row matched; null on the user-scoped fallback).
- [x] **Change #2:** Key `enforceRateLimit()` by credential ID — storage key
  `` `rate-limit:${credentialId}` `` and accept `credentialId` param.
- [x] **Change #3:** Move the `enforceRateLimit()` call to AFTER the grace/stale/match
  branches (just before the upstream OpenAI fetch) so cached/stale/grace responses
  do NOT consume rate-limit budget.
- [x] **Change #4 (invariant):** Keep the stale-credential return behavior unchanged —
  stale path still returns `{ accessToken, idToken, stale: true }` (NO refresh_token).
- [x] **Tests — dual-write:** after rotation, BOTH legacy `credentials` AND
  `cc_credentials` rows updated, for user-scoped AND project-scoped credentials.
- [x] **Tests — vertical slice regression:** the DO writes identical ciphertext/iv to both
  the legacy and `cc_credentials` rows in the same rotation, so the workspace seeding path
  (`runtime.ts`, reads `cc_credentials`) reflects the latest rotated token. Asserted by the
  ciphertext/iv-parity test + the stale-branch-no-cc-write test.
- [x] **Tests — rate limit:** keyed by credential ID (distinct credentials have
  distinct buckets); cached/grace/stale responses don't consume budget; only real
  OpenAI calls count; at-limit rejection (429 + Retry-After); window rollover resets.
- [x] **Post-mortem + process fix:** post-mortem recorded below; process-fix rule added at
  `.claude/rules/44-dual-write-migration-enumerate-writers.md`.

## Post-Mortem

**What broke.** Production Codex sessions returned `429 Too Many Requests` from the SAM
Codex refresh proxy. Fresh workspaces seeded `~/.codex/auth.json` with a stale
`refresh_token` and looped re-refreshing until they exceeded the rate limit.

**Root cause.** The composable-credentials migration (#1315 2026-06-14, #1332 2026-06-16)
introduced `cc_credentials` as a new representation of legacy `credentials` and updated the
resolution + Connections write paths to dual-write. It did NOT enumerate every writer of the
legacy table. The `CodexRefreshLock` Durable Object rotates the Codex OAuth `refresh_token`
and persisted ONLY to legacy `credentials`, never mirroring into `cc_credentials`. Workspaces
seed `auth.json` from the (frozen) `cc_credentials` snapshot, so they presented a stale token.

**Timeline.** Migration merged 2026-06-14. `cc_credentials` codex copy frozen at
`2026-06-14 13:27:02`. Legacy credential `01KR9EAKXA1BPQQT8B3VCZQZDW` kept rotating
(`updated_at = 2026-06-20 02:07:09`). The desync surfaced only once the 5-minute grace window
expired on freshly provisioned workspaces — weeks after the migration.

**Why it wasn't caught.** The migration tested the resolution path and the Connections write
path. No test enumerated all writers of `credentials`; the DO rotation writer was missed.
Durable Objects hold their own DB handle and are easy to overlook when grepping for writers.
Both reads and the legacy write individually worked, so the divergence was silent.

**Class of bug.** Dual-write desync after a storage migration — a write path (here a
background rotation writer) is not updated to sync the second representation. One side keeps
changing; the other goes stale, silently.

**Process fix.** Added `.claude/rules/44-dual-write-migration-enumerate-writers.md`: any
migration that introduces a synced second representation must enumerate EVERY writer of the
source table (including Durable Objects), decide dual-write / read-only / tracked-follow-up
for each, and add a per-writer behavioral test asserting both representations update in every
scope, plus a vertical-slice test proving the downstream consumer sees the latest write.

## Second Post-Mortem (theory A — concurrency race)

The dual-write fix (#1439) resolved the stale-`cc_credentials` desync but the user
confirmed the 429 still recurred. The user definitively ruled out any external
competing refresher ("I made fresh json objects every time I put creds in: login,
copy json, logout ... No chance that is the problem"), so the remaining cause had
to be inside SAM.

**What broke.** Codex refresh kept returning `unauthorized`/"access token could not
be refreshed" in production. A user with two workspaces running concurrently could
have both refresh the same one-time-use `refresh_token` against OpenAI; OpenAI
rotates the token on first use and revokes the whole token family when the consumed
token is replayed → 401 → codex re-refresh loop → 429.

**Root cause.** `CodexRefreshLock` assumed the Durable Object "single-threaded
execution model" serialized requests "without explicit mutex logic." False: a DO
does NOT serialize concurrent `async fetch()` handlers across `await` points. When
request A `await`ed the OpenAI fetch, request B ran, read the same pre-rotation
stored token, and also POSTed it. The `AbortController` timeout bounds duration but
is not a mutex. The credential read happened outside any lock.

**Why it wasn't caught.** No concurrency test existed for the DO; all tests issued
a single request. The false "single-threaded" doc comment actively discouraged
adding a lock.

**Class of bug.** Durable Object check-then-act race across an `await` boundary on
a one-time-use rotating resource.

**Fix.** Added an in-DO promise-chain mutex (`withRefreshLock`) and moved the
credential read + OpenAI refresh + write into a serialized `runRefresh` critical
section. Reading the credential inside the lock lets a queued second request observe
the rotated token and take the grace-window handoff path instead of replaying the
consumed token. Corrected the false doc comment.

**Process fix.** Added `.claude/rules/45-durable-object-concurrency-mutex.md`: DO
check-then-act critical sections on rotating/one-time-use resources must use a real
mutex (`blockConcurrencyWhile` or a promise-chain lock), read mutated state inside
the lock, and ship a concurrency regression test (dynamic state-mutating mocks;
assert the one-time-use mutation fires exactly once; proven to fail when the mutex
is bypassed).

## Third Post-Mortem (theory B — externally-revoked token; DEFINITIVE)

The user had **definitively ruled out** any external competing refresher
("I made fresh json objects every time I put creds in: login, copy json, logout
... No chance that is the problem"). With concurrency (#1445) and dual-write
(#1439) both fixed, the 429/unauthorized still recurred — so the root cause had
to be locatable inside the captured evidence.

**Diagnostic added.** The DO's `!upstreamResponse.ok` branch previously called
`readResponseJson()` (which throws on the body and discarded OpenAI's actual
error), so production logs never showed *why* OpenAI rejected a refresh. We
rewrote that branch to parse OpenAI's error body and emit a structured,
leak-safe `codex_refresh.upstream_rejected` warn log carrying the OAuth/OpenAI
error code + message (never the raw body).

**What the live tail captured.** On staging, a single workspace (zero
concurrency) submitted one codex task (`01KWD7HJ70RB2AR0D6T8XGXAFS`). At
21:39:46 the refresh hit SAM (`codex_refresh.request_received`), SAM faithfully
forwarded the stored token, and OpenAI rejected it on the **first** attempt
with HTTP 401:

```json
{"error":{"message":"Your session has ended. Please log in again.",
"type":"invalid_request_error","param":null,"code":"refresh_token_invalidated"}}
```

credentialId `01KWCSQ0ACGB0HXP4EN884BZ4A`, status 401, content-type
`application/json`.

**Supporting evidence.** That credential row (`SELECT … FROM credentials`):
`created_at` == `updated_at` == `2026-06-30T17:37:29.420Z` — i.e. **never
rotated by SAM**. Every refresh got 401, so SAM never wrote a rotated token
back. The token was already dead at OpenAI ~2h before SAM first used it.

**Root cause.** The stored `refresh_token` is **revoked at OpenAI before SAM
ever uses it.** `refresh_token_invalidated` / "Your session has ended" is the
signature of an explicitly-revoked token *family* — not an expired access token,
not a one-time-use replay. The user's credential-capture workflow is
"login → copy auth.json → **logout**". The `codex logout` step revokes the
refresh-token family at OpenAI, killing the copied token before SAM seeds and
uses it.

**This is NOT a SAM code bug.** It is not the concurrency race (#1445) and not
the dual-write desync (#1439). Both of those were real latent bugs and are
legitimate defense-in-depth, but neither caused the user's reported failure. SAM
behaved correctly: it forwarded the token it was given and surfaced OpenAI's
rejection.

**The fix (user-side).** Do NOT `logout` after copying `auth.json`. Leave the
ChatGPT/Codex session active so the refresh-token family stays valid. A fresh,
non-logged-out credential must be seeded before the HARD-GATE E2E can pass.

**Process fix.** The diagnostic itself is the process fix: the failure was
undiagnosable for weeks because the DO discarded OpenAI's error body and the
error path logged nothing useful. The permanent `codex_refresh.upstream_rejected`
structured log (error code + message, no raw body) makes the revoked-vs-transient
distinction observable on the first occurrence going forward. Covered by a
behavioral regression test asserting the nested OpenAI error form is parsed,
`refresh_token_invalidated` is surfaced, and no raw body is logged.

**HARD GATE status.** "Real Codex refresh exercised E2E on staging" cannot pass
with the current staging credential because its refresh-token family is already
revoked at OpenAI. Blocked on a human re-seeding a valid (non-logged-out)
credential. PR #1445 labeled `needs-human-review`; do NOT merge until verified.

## Acceptance Criteria

- [x] Concurrent refreshes for the same user are serialized; the consumed
  one-time-use token is presented to OpenAI exactly once (verified by a
  concurrency regression test proven to fail when the mutex is bypassed).
- [x] After a Codex refresh rotation, the matching `cc_credentials` row's
  `encrypted_token`/`iv`/`updated_at` are updated in the same DO operation as the
  legacy `credentials` row (verified by a behavioral test for both scopes).
- [x] A freshly provisioned workspace seeds `auth.json` with the rotated token, not a
  stale backfill token (verified by the ciphertext/iv-parity dual-write test; seeding
  consumer in `runtime.ts` reads `cc_credentials`).
- [x] Rate limit is per-credential and only consumed by real OpenAI refreshes
  (verified by tests for keying, cached-no-consume, at-limit, and rollover).
- [x] Stale-credential responses still omit the rotating refresh_token.
- [x] No decrypted token material is ever logged.
- [x] Rate-limit window/limit remain env-configurable with `Default*` constants.
- [ ] Real Codex refresh exercised E2E on staging before merge (HARD GATE).
  **BLOCKED** — staging credential `01KWCSQ0ACGB0HXP4EN884BZ4A` is revoked at
  OpenAI (`refresh_token_invalidated`; see Third Post-Mortem). Requires a human
  to seed a fresh, non-logged-out Codex credential. `needs-human-review` applied.

## References
- SAM idea 01KWBRKQHR5SPVKG7Q09ZFJQ5Y
- `.claude/rules/02`, `13`, `28`, `30`, `35`, Constitution Principle XI
- PRs #1315, #1332 (composable-credentials migration)
