# Fix: enabled platform agent default short-circuits CC lazy backfill + legacy fallback

Idea: `01KV30DRD0BH2F4GGG1J7C3V1H`

## Problem

After the composable-credentials (CC) three-primitive rollout (PR #1315/#1316), production
had to be rolled back. Users with their OWN agent credential (e.g. a claude-code
`oauth-token`) got `agent-key` 404 → vm-agent "no credential configured for claude-code"
→ agent status error. `cc_credentials` stayed at 0 rows — lazy backfill never ran.

### Root cause (production evidence)

Prod `platform_credentials` has an ENABLED claude-code `agent-api-key` default
(id `01KPT2TM5E703ED151D1T860PK`, `is_enabled=1`).

For a user with empty `cc_*` tables and their own `oauth-token` claude-code credential:

1. `resolveAgentKeyViaCC` → `resolveForConsumer` → `resolveEnvironment` resolves at
   **Tier 3 (platform default)** on the FIRST call, returning a non-null result.
2. The lazy-backfill block in `resolveAgentKeyViaCC` runs only `if (!resolved)`. Because
   the first resolve is non-null, **backfill is SKIPPED** → `cc_credentials` is never
   populated (exactly why no backfill ever happened).
3. `mapResolvedToLegacy` returns the platform api-key (`source: 'platform'`, non-null) →
   `resolveAgentKeyViaCC` returns a defined value → `getDecryptedAgentKey` **SKIPS
   `resolveAgentKeyLegacy`**, the only path that would have found the user's `oauth-token`.
4. `runtime.ts` discards the platform credential for claude-code because `providerMode != 'sam'`
   → **404**.

Net: the enabled platform default short-circuits BOTH lazy backfill AND legacy fallback.
The user's own credential is never consulted. Affects every user with their own
non-platform agent credential when a matching enabled platform default exists.

### Conversation-vs-task discrepancy (not a mode behavior)

The reporter saw 2 conversation sessions fail and 1 task session succeed. This was a
deployment-timing coincidence: a Cloudflare instant-rollback burst landed 11:37:57–11:38:29.
agent-key fetches: 11:25:55 FAIL, 11:32:06 FAIL (CC code), 11:38:08 SUCCESS (rolled-back
legacy-only code). Task vs conversation is irrelevant — only which code version served the
agent-key fetch.

## Fix

A **platform-sourced** first resolution must NOT pre-empt lazy backfill + the user's own
credentials. In `resolveAgentKeyViaCC` (`apps/api/src/routes/credentials.ts`):

- If the first resolution returns nothing OR resolves only to a platform default, attempt
  lazy backfill (which migrates the user's legacy credentials into `cc_*`), then re-resolve.
- After backfill, a user/project-tier attachment (Tier 1/2) correctly out-precedes the
  platform default (Tier 3) in `resolveEnvironment`, so the user's own credential wins.
- If no own credential exists, the platform default still resolves and is returned —
  identical to prior/legacy behavior (no regression).

This is the minimal change: the platform tier stops suppressing the higher-precedence
user/project tiers that lazy backfill materializes.

## Implementation checklist

- [x] In `resolveAgentKeyViaCC`, detect a platform-only first resolution
      (`source === 'platform' || source === 'platform-proxy'`).
- [x] When first resolution is null OR platform-only, call `lazyBackfillIfNeeded`; if it
      backfilled, re-resolve and prefer the re-resolved result.
- [x] Preserve the existing `undefined` (legacy fallback) path when nothing resolves and no
      backfill ran.
- [x] Preserve Rule 28 (inactive project attachment halts → null, no fallback).
- [x] Add a behavioral worker test: user with own oauth-token claude-code + enabled platform
      claude-code default + empty `cc_*` → resolves to the USER's oauth-token (source 'user'),
      `cc_credentials` is populated (backfill ran), NOT 404 / NOT platform.

## Acceptance criteria

- User with own `oauth-token` agent credential resolves to THAT credential even when an
  enabled matching platform default exists (no 404, source `user`).
- Lazy backfill runs in that scenario (`cc_credentials` populated for the user).
- A user with NO own agent credential still falls through to the platform default (unchanged).
- Rule 28 inactive-project-halt behavior preserved.
- `pnpm lint && pnpm typecheck && pnpm test && pnpm build` green.

## References

- `apps/api/src/routes/credentials.ts` — `getDecryptedAgentKey`, `resolveAgentKeyViaCC`, `mapResolvedToLegacy`
- `packages/shared/src/composable-credentials/resolver.ts` — `resolveEnvironment` tier order
- `apps/api/src/services/composable-credentials/lazy-backfill.ts`
- `apps/api/tests/workers/composable-credentials-wiring.test.ts` — existing wiring tests
- `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/41-credential-snapshot-resilience.md`
