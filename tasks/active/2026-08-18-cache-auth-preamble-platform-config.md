# Cache the auth preamble — resolve platform config once, then cache it per isolate

**Status**: Active
**Program**: UI Performance Plan (SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ`) — Workstream A, item #1
**Integration branch**: `sam/read-idea-01m09skvnjgjnjy2wgcz6d89xz-using-bmbgfz`

## Problem

Every authenticated API request rebuilds the BetterAuth instance from D1 before any handler runs.

`createAuth()` (`apps/api/src/auth.ts:203-209`) awaits three OAuth config helpers **sequentially**:

```ts
const githubOAuth = await getGitHubOAuthConfig(env);
const googleOAuth = await getGoogleLoginOAuthConfig(env);
const gitlabOAuth = await getGitLabOAuthConfig(env);
```

Each helper independently calls `resolvePlatformConfig(env)`
(`apps/api/src/services/platform-config.ts:441-504`), which issues **13 D1 queries** in one
`Promise.all` — 7 `resolveSetting` → `readSetting` (`platform_settings` lookups) plus 6
`resolveSecret` (`platform_credentials` lookups). Three helpers × 13 = **39 D1 queries in 3
sequential round-trip waves**, on every authenticated request.

Worse, `createAuth` is invoked from 9 call sites and more than one can run per request:
`requireAuth()` (`middleware/auth.ts:103`) builds an instance, and a handler such as
`routes/auth.ts:18` builds a second one — up to **78** platform-config queries for a single
`GET /api/auth/me`.

On top of that, every `getSession` call passes `query: { disableCookieCache: true }`
(`middleware/auth.ts:106,132`, `index.ts:330`, `routes/auth.ts:21`,
`services/session-factory.ts:72`), forcing a fresh session + user D1 lookup (~2 queries), and
`requireApproved()` adds `isSignupApprovalRequired()` (1 query). Roughly **42 D1 round-trips
before any handler runs**.

This violates the read-only-GET budget of ≤ 8 round-trips in
`.claude/rules/60-request-io-and-bundle-budgets.md` before the handler has done any work at all,
and it is exactly the "three agents each added a `resolvePlatformConfig()` call" case cited in
`.claude/rules/59-understand-before-adding.md`.

## Research findings

1. **`resolvePlatformConfig` is 13 queries, already parallelised internally.** The waste is the
   three *independent* invocations, not the function itself. (`platform-config.ts:441-479`)

2. **Seven exported helpers each re-resolve the whole config**: `getGitHubOAuthConfig` (:506),
   `getGitLabOAuthConfig` (:521), `getGoogleLoginOAuthConfig` (:549), `getGoogleInfraOAuthConfig`
   (:563), `getGitHubAppConfig` (:574), `getGitHubWebhookSecret` (:588) and (transitively)
   `areGitHubTriggersConfigured` (:593). Every one of them is a thin *pure projection* over the
   resolved config — the projection can be split out and reused without touching D1.
   → Checklist items A1, A2.

3. **The audit's line citation for `disableCookieCache` had drifted.** `auth.ts:338-343` actually
   *enables* `session.cookieCache` with a 5-minute `maxAge`; the disable is at each **call site**.
   So "removing `disableCookieCache: true`" means editing 5 call sites, not one config flag.
   → Checklist item C1 (decision), C2 (documentation).

4. **Suspension/approval enforcement reads the session-user snapshot.** `requireAuth` calls
   `assertUserNotSuspended(authContext.user)` (`middleware/auth.ts:114`) and `requireApproved`
   calls `assertUserAllowedBySignupApproval(..., auth.user)` (`middleware/auth.ts:161`), both
   reading `user.status` / `user.role` straight out of the BetterAuth session payload. Enabling
   the cookie cache would serve that snapshot from a signed cookie for up to 5 minutes, so a
   suspended or de-approved account would retain full access for that window. There is **no
   secondary status re-check on write paths** that would compensate.
   `.claude/rules/02-quality-gates.md` → "Unconditional Account-Denial Gates" requires `suspended`
   to be enforced before any bypass logic. → Checklist item C1 resolves this **conservatively**.

5. **An established per-isolate cache pattern already exists** in
   `apps/api/src/services/trial/kill-switch.ts:14-41`: local `DEFAULT_*_CACHE_MS` constant, env
   override resolver, module-scope `let cache`, and `__reset*ForTest()`. Per
   `.claude/rules/59-understand-before-adding.md` and `.claude/rules/24-no-duplicate-implementations`,
   reuse that shape rather than inventing a second caching idiom. → Checklist item B1.

6. **Writers of the cached data (rule 44 enumeration).** Only two functions mutate any input of
   `ResolvedPlatformConfig`, both in `platform-config.ts`: `savePlatformIntegrationConfig` (:194)
   and `completeSetupWithConfig` (:420), both through `buildPlatformIntegrationStatements`
   (setting upsert :221, credential update/insert :246/:253, removal deletes :297/:300).
   `writeSetting` (:106) is only reached from `setSetupCompleted` and writes `setup.completed`,
   which is not part of the resolved config. `routes/admin-platform-credentials.ts` writes only
   `cloud-provider` / `agent-api-key` credential types, never `platform-integration`.
   `services/signup-approval.ts` and `services/credential-mutation-rate-limit.ts` write unrelated
   `platform_settings` keys. → Checklist item B3 (invalidate exactly those two paths).

7. **The existing `platform-config.test.ts` suite is a discriminating canary.** It builds a fresh
   in-memory SQLite D1 per `createEnv()` call and asserts different resolutions across tests
   (env-fallback at :116 vs. runtime rows at :271). A naive single-slot cache would make those
   tests cross-contaminate, so the cache must be keyed on the `D1Database` binding identity **and**
   the suite must reset it between tests. → Checklist items B2, T5.

8. **`isSignupApprovalRequired` is deliberately NOT cached.** It is the account-denial gate
   (`assertUserAllowedBySignupApproval`); caching it would delay an admin turning approval *on* by
   up to the TTL. One query is the correct price. → Checklist item C3 (documented non-goal).

## Implementation checklist

### Step A — resolve once

- [x] **A1**: Extract pure selectors in `platform-config.ts` that project a
      `ResolvedPlatformConfig` into each consumer shape: `selectGitHubOAuthConfig`,
      `selectGitLabOAuthConfig`, `selectGoogleLoginOAuthConfig`, `selectGoogleInfraOAuthConfig`,
      `selectGitHubAppConfig`, `selectGitHubWebhookSecret`.
- [x] **A2**: Re-express the existing `get*` async helpers as
      `select*(await resolvePlatformConfig(env))` so the ~15 other call sites are unchanged.
- [x] **A3**: `createAuth` resolves the config **once** and calls the three selectors. 39 → 13.

### Step B — per-isolate TTL cache

- [x] **B1**: Add `DEFAULT_PLATFORM_CONFIG_CACHE_MS = 60_000` + `PLATFORM_CONFIG_CACHE_MS` env
      override (`apps/api/src/env.ts`), mirroring `kill-switch.ts`.
- [x] **B2**: Module-scope single-slot cache guarded on `env.DATABASE` identity + `expiresAt`.
      A different binding or an expired entry re-resolves. `__resetPlatformConfigCacheForTest()`
      exported. **Amended during implementation**: an env with no usable D1 binding must not be
      cached at all — keying on `env.DATABASE` alone made two database-less envs match via
      `undefined === undefined` and share an entry (caught by the pre-existing
      `login-providers-config.test.ts`). Guarded by `isCacheableBinding()`.
- [x] **B3**: Invalidate after `savePlatformIntegrationConfig` and `completeSetupWithConfig`
      write, before the fresh re-resolve they return.
- [x] **B4**: Setting `PLATFORM_CONFIG_CACHE_MS=0` disables caching (always re-resolve).
- [x] **B5** (added in review): generation compare-and-set so a slow read that started before a
      write cannot publish its pre-write snapshot over the writer's fresh entry. Raised
      independently as HIGH by `security-auditor` (empirically reproduced) and MEDIUM by
      `cloudflare-specialist`.
- [x] **B6** (added in review): single-flight — concurrent misses on a cold/just-expired isolate
      join one read instead of each issuing 13 queries. Raised by `performance-reviewer` (MEDIUM)
      and `security-auditor` (LOW).

### Step C — cookie-cache decision

- [x] **C1**: **Keep `disableCookieCache: true` on all session-reading paths.** Do not re-enable
      the 5-minute BetterAuth cookie cache.
- [x] **C2**: Document the decision + rationale in the PR description and in a code comment at
      `auth.ts`'s `session.cookieCache` block.
- [x] **C3**: Document that `isSignupApprovalRequired` is intentionally left uncached.

### Tests

- [x] **T1**: D1 round-trip counter proving `createAuth` issues 13 platform-config queries on a
      cold isolate (fails on pre-fix code, which issues 39).
- [x] **T2**: Second `createAuth` on a warm isolate issues **0** platform-config queries.
- [x] **T3**: TTL expiry re-resolves; `PLATFORM_CONFIG_CACHE_MS=0` never caches.
- [x] **T4**: Write-path invalidation — a config save is observed by the next read immediately.
- [x] **T5**: Cache isolation — a different `D1Database` binding is never served a cached value.
- [x] **T6**: Selector parity — `select*` output equals the corresponding `get*` output.
- [x] **T7**: Account-gate regressions unaffected by caching: active passes, pending blocked when
      approval required, suspended blocked in **all** configurations (approval on and off, and as
      admin/superadmin), admin bypasses pending-approval only.
- [x] **T8**: Reset the cache in the existing `platform-config.test.ts` `beforeEach`.
- [x] **T9** (added in review): discriminating race regression — a read stalled mid-flight across
      a config write must not clobber the fresh entry. Verified it fails with the CAS removed.
- [x] **T10** (added in review): three concurrent cold misses issue 13 queries total, not 39.
      Verified it fails with the join removed.

### Docs

- [x] **D2** (added in review): document the cross-isolate propagation delay for credential
      rotation in `apps/www/src/content/docs/docs/architecture/security.md`.
- [x] **D1**: `PLATFORM_CONFIG_CACHE_MS` documented in `apps/api/.env.example` **and**
      `apps/www/src/content/docs/docs/reference/configuration.md` (Worker Variables table —
      it does list comparable tunables, e.g. `CONTROL_LOOP_KILL_SWITCH_CACHE_MS`).

## Acceptance criteria

1. `createAuth` performs exactly one `resolvePlatformConfig` (13 D1 queries) on a cold isolate —
   covered by T1.
2. A warm isolate within the TTL performs **0** D1 queries for platform config — covered by T2.
3. Platform-config writes are visible to the next read without waiting for the TTL — covered by T4.
4. The cache never serves a value resolved from a different D1 binding — covered by T5.
5. Suspended and pending-approval enforcement is byte-for-byte unchanged — covered by T7.
6. TTL is configurable via env with a `DEFAULT_*` constant (Constitution XI) — covered by T3.
7. No behaviour change for the ~15 existing `get*` call sites — covered by T6.

## References

- SAM idea `01M09SKVNJGJNJY2WGCZ6D89XZ` (UI Performance Plan, Tier 1 item #1)
- `.claude/rules/60-request-io-and-bundle-budgets.md` — per-isolate cache pattern, I/O budgets
- `.claude/rules/59-understand-before-adding.md` — trace the shared path, reuse existing patterns
- `.claude/rules/02-quality-gates.md` — Unconditional Account-Denial Gates
- `.claude/rules/44-dual-write-migration-enumerate-writers.md` — enumerate every writer
- `.claude/rules/24-no-duplicate-ui-controls.md` — one implementation per operation
- Existing pattern: `apps/api/src/services/trial/kill-switch.ts`

## Review findings and disposition

| Reviewer | Severity | Finding | Disposition |
|---|---|---|---|
| security-auditor | HIGH | Slow in-flight read clobbers a fresh post-write cache entry, reinstating a just-rotated secret for a TTL | **Fixed** — generation CAS + discriminating test T9 |
| cloudflare-specialist | MEDIUM | Same race, independently found | **Fixed** — same |
| task-completion-validator | HIGH | `configuration.md` not updated though it lists comparable tunables | **Fixed** — D1 |
| performance-reviewer | MEDIUM | No single-flight; N concurrent misses each pay 13 queries | **Fixed** — B6 + test T10 |
| performance-reviewer | MEDIUM | Diverges from `kill-switch.ts`, which caches its fail-closed default on read error | **Won't fix, documented** — there is no safe default here; caching "no OAuth configured" would disable all social login for a TTL. Rationale in the `resolvePlatformConfig` doc comment. |
| security-auditor | MEDIUM | No cross-isolate invalidation; rotation converges only within the TTL | **Accepted + documented** — inherent to a per-isolate cache; `security.md` now tells operators to revoke at the provider |
| security-auditor | LOW | `security.md` credential table omits the cache | **Fixed** — D2 |
| security-auditor | LOW | Cached entry holds decrypted secrets in isolate memory for the TTL | **Accepted** — same trust boundary as the Worker env vars; documented |
| task-completion-validator | LOW | `invalidatePlatformConfigCache` exported without external consumers | **Fixed** — made module-private |
| task-completion-validator | LOW | New test file does not cross-reference the account-gate matrix | **Fixed** — comment added |
| performance-reviewer | LOW | 60s TTL is conservative; longer would cut D1 further | **Won't change** — 60s bounds credential-rotation staleness; the extra reduction is not worth a longer exposure window |
| cloudflare-specialist | INFO | No `wrangler.toml` / sync-script entry needed | Confirmed — matches the `SETUP_RATE_LIMIT_*` precedent |
| security-auditor | out of scope | `PUT /api/setup/config` echoes plaintext secrets (pre-existing) | **Filed** — `tasks/backlog/2026-08-18-setup-config-echoes-plaintext-secrets.md` |

### Binding-identity question (resolved)

`cloudflare-specialist` confirmed against official Cloudflare docs that `env` and its bindings are
constructed once per isolate and are stable across requests. It also confirmed the design is safe
even if that were not true: `database` is recomputed from `env.DATABASE` on every call and a hit
requires `cached.database === database`, so non-stable identity degrades to "cache never hits"
(losing Step B's win, keeping Step A's) and can never serve a foreign config. The Vitest pool
reuses module caches across test files, which is what makes `__resetPlatformConfigCacheForTest()`
load-bearing rather than defensive.
