# Fix CodexRefreshLock scope gate burning Codex OAuth token families

- SAM diagnosis task: 01KY439H3VR0FD6R1K796FT1QF (this session)
- Root-caused production incidents: codex auth deaths of 2026-07-11 ("refresh token was revoked") and 2026-07-22 ("refresh token was already used")

## Problem Statement

`CodexRefreshLock.runRefresh` validates the scopes in OpenAI's refresh response
AFTER the one-time-use refresh token has been consumed by the upstream exchange,
and on mismatch returns 502 `upstream_unexpected_scope` and **discards the rotated
tokens without persisting them** (PR #1412, merged 2026-07-01, CRED-002 hardening).
For a rotating one-time-use token family this is destructive: the old refresh token
is already dead at OpenAI, the new one is thrown away, and the family is permanently
stranded.

Codex 0.144.x logins create grants with scopes
`openid profile email offline_access api.connectors.read api.connectors.invoke`
(verified in codex-rs `login/src/server.rs:build_authorize_url` at rust-v0.144.6).
SAM's `DEFAULT_EXPECTED_SCOPES` allowlist contains only the first four, and
`CODEX_EXPECTED_SCOPES` is unset in production (verified via Worker settings API).
Therefore the FIRST refresh of every credential seeded from a current codex login
burns the family.

The failure is invisible for ~10 days because codex falls back to the still-valid
cached access token when a refresh fails (`manager.rs auth()` swallows refresh
errors); everything dies at access-token expiry with ACP `-32000` "Your access
token could not be refreshed because your refresh token was already used."

Production evidence (2026-07-22 diagnosis):
- `credentials` row `01KWVMAH8X4DKQ4G8C3RK3N54K` frozen at `2026-07-11T17:34:38.809Z`
  in ISO (app-write) format — the DO's `datetime('now')` format never appears, so the
  DO has never successfully persisted a rotation for this credential.
- Overnight failures 02:10 (Dependabot), 03:32 (TTV), 04:55 (Sol chat) all
  `refresh_token_reused` — proving an earlier refresh DID reach OpenAI successfully
  yet nothing persisted; the scope gate is the only designed success-then-discard path.
- Local repro with pinned `@agentclientprotocol/codex-acp@1.1.2` + `@openai/codex@0.144.6`:
  codex refreshes at every `session/new` and honors `CODEX_REFRESH_TOKEN_URL_OVERRIDE`.

## Research Findings

- Core file: `apps/api/src/durable-objects/codex-refresh-lock.ts`
  - Current order in `runRefresh`: upstream fetch → `!ok` handling → abort check →
    parse (`readResponseJson`) → `validateUpstreamScopes` (502 + discard on fail) →
    `recordRotatedToken` → legacy `UPDATE credentials` → `syncActiveAgentCredentialSecret`
    (cc dual-write, non-fatal) → token response.
  - The abort-check between upstream success and DB write is the same
    lost-rotation class: a lock-timeout firing in that window discards a completed
    rotation (504) — must also be fixed.
- Config: `apps/api/src/durable-objects/codex-refresh-lock-config.ts` —
  `DEFAULT_EXPECTED_SCOPES = 'openid,profile,email,offline_access'`;
  `CODEX_EXPECTED_SCOPES` env (unset = default, `''` = disable).
- Durable diagnostics: `persistError()` in `apps/api/src/services/observability.ts`
  writes `platform_errors` in `OBSERVABILITY_DATABASE` (fail-silent, truncating,
  source `'api'`). DOs share the Worker env, so the DO can call it with an optional
  `OBSERVABILITY_DATABASE` binding on `CodexRefreshEnv`. Needed because production
  Workers Logs sample at 1% (`observability.logs.head_sampling_rate=0.01`) — the
  `unexpected_scopes_blocked` warn logs never surfaced.
- Tests: `apps/api/tests/unit/durable-objects/codex-refresh-lock.test.ts` currently
  asserts block-and-not-persist as desired behavior (must flip per rule 42 — they
  lock in the destructive behavior).
- Rule 28 §3 ("Rotation Scope Validation") requires "Rejected rotations MUST NOT
  persist the new credential (the old credential remains valid)" — the premise
  "the old credential remains valid" is FALSE for one-time-use rotating upstreams.
  The rule must be amended (process fix), or the class recurs.
- Post-mortems reviewed: `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md`
  (mutex + dual-write + diagnostics), `tasks/archive/2026-06-25-codex-refresh-scope-block.md`
  (the change that introduced this bug; its staging E2E hard gate was never satisfied —
  blocked on a revoked staging credential).

## Implementation Checklist

- [x] Reorder `runRefresh`: after a successful upstream exchange, ALWAYS persist —
      `recordRotatedToken` → legacy `UPDATE credentials` → cc dual-write — before any
      scope evaluation. A completed rotation must never be discarded.
- [x] Convert scope validation from blocking to alerting: rename/reshape
      `validateUpstreamScopes` into a detector that returns unexpected scopes; on
      anomaly, `log.error('codex_refresh.unexpected_scopes', …)` + persist a durable
      diagnostic; still deliver the rotated tokens to the caller.
- [x] Preserve `CODEX_EXPECTED_SCOPES` semantics: unset → default allowlist;
      `''` → detection disabled; custom list → custom allowlist (alert-only now).
- [x] Expand `DEFAULT_EXPECTED_SCOPES` to
      `openid,profile,email,offline_access,api.connectors.read,api.connectors.invoke`.
- [x] Remove the abort-check between upstream success and persist so a lock-timeout
      can no longer discard a completed rotation (aborts still cancel the upstream
      fetch itself).
- [x] Add optional `OBSERVABILITY_DATABASE?: D1Database` to `CodexRefreshEnv`; persist
      durable diagnostics (fail-silent) for: unexpected-scope anomaly, and upstream
      rejections with family-fatal codes (`refresh_token_reused`,
      `refresh_token_invalidated`, `refresh_token_expired`).
- [x] Tests — flip existing block-and-not-persist scope tests to
      persist-and-alert (rule 42: stop asserting destructive behavior as desired).
- [x] Tests — discriminating regression: upstream success with
      `api.connectors.read api.connectors.invoke` in scope → passes with NO anomaly
      under the new default allowlist (fails on old default).
- [x] Tests — scope anomaly (custom narrow allowlist): rotated tokens ARE persisted to
      legacy AND cc rows, tokens ARE returned, durable diagnostic persisted.
- [x] Tests — `CODEX_EXPECTED_SCOPES=''` disables detection (no anomaly, persisted).
- [x] Tests — upstream rejection with `refresh_token_reused` persists a durable
      diagnostic and does not touch stored credential.
- [x] Tests — existing concurrency/mutex, grace-window, rate-limit, dual-write tests
      remain green.
- [x] Process fix: amend `.claude/rules/28-credential-resolution-fallback-tests.md`
      §3 with the one-time-use rotating-upstream carve-out (persist-then-alert;
      reject-no-persist is forbidden when the upstream consumes the credential).
- [x] Docs: update `CODEX_EXPECTED_SCOPES` description in env reference material
      (`apps/api/.env.example` if present) to reflect alert-only semantics + new default.
- [x] Post-mortem recorded in this task file (below) per rule 02.

## Acceptance Criteria

- A refresh whose upstream response contains unexpected scopes persists the rotated
  tokens to BOTH `credentials` and `cc_credentials` in the same operation and returns
  them to the caller; a durable `platform_errors` diagnostic is written.
- A refresh returning the codex 0.144.x scope set produces zero anomalies with the
  default allowlist.
- No code path discards a completed upstream rotation (including lock-timeout after
  upstream success).
- Family-fatal upstream rejections (`refresh_token_reused` / `refresh_token_invalidated` /
  `refresh_token_expired`) produce durable diagnostics that survive log sampling.
- All updated/added tests pass; concurrency and grace-window behavior unchanged.
- Staging verification: a codex session on staging triggers a refresh through the
  proxy and the staging `credentials.updated_at` advances (in `datetime('now')`
  format), or — if the staging family is already burned — the durable diagnostic
  appears in the staging observability DB and a freshly re-seeded credential rotates
  successfully.

## Post-Mortem (rule 02)

**What broke.** Every Codex OAuth credential seeded since 2026-07-01 was permanently
burned on its first refresh through the SAM proxy. Sessions kept working ~10 days on
the cached access token, then all codex sessions failed with "refresh token was
already used" (2026-07-11 and 2026-07-22 production incidents).

**Root cause.** PR #1412 (CRED-002) changed refresh-response scope validation from
warn-and-persist to block-and-discard. For OpenAI's rotating one-time-use refresh
tokens the "block" happens after the upstream exchange has consumed the old token,
so discarding the response destroys the only surviving credential. Codex 0.144.x
logins grant two connector scopes beyond SAM's four-scope allowlist, so the gate
fired on every refresh of every newly seeded credential.

**Timeline.** 2026-07-01: #1412 merges (block-and-discard scope gate).
2026-07-06: first post-gate credential seeded; burned on first refresh; visible
death 2026-07-11 ("revoked") → re-seed at 17:34 UTC. 2026-07-12 → 07-21: sessions
coast on the seeded 10-day access token while every refresh silently fails.
2026-07-21 ~17:34: access token expires. 2026-07-22 02:10/03:32/04:55: all codex
sessions fail with "refresh token was already used"; diagnosed same day.

**Why it wasn't caught.**
1. #1412's real-refresh staging E2E was never performed — the hard gate was blocked
   at the time by a revoked staging credential, and the change later merged.
2. Tests asserted block-and-not-persist as the DESIRED outcome (rule 42 violation —
   a green suite locking in destructive behavior).
3. The `unexpected_scopes_blocked` warn log was effectively invisible at 1% Workers
   log sampling.
4. Codex's silent fallback to the cached access token delayed the user-visible
   failure by ~10 days, decoupling cause from symptom.
5. This exact lesson had been learned and lost once before: the scope check
   originally shipped warn-first (PR #772, 2026-04-21 journal: "validate-then-block
   should always start as validate-then-warn") and #1412 reverted it to
   block-by-default citing rule 28 §3's false "old credential remains valid"
   premise — the lesson lived in a blog post, not an enforced rule.

**Class of bug.** Post-consumption validation gate discarding a one-time-use rotated
credential — "reject-no-persist" applied to an upstream where rejection cannot
preserve the prior credential.

**Process fix.** Rule 28 §3 amended: for one-time-use rotating upstreams, completed
rotations must ALWAYS be persisted; validation failures alert/flag (durably, past
log sampling) instead of discarding. Durable diagnostics added for family-fatal
refresh failures.

## References

- `.claude/rules/28-credential-resolution-fallback-tests.md` §3
- `.claude/rules/42-no-untracked-degrading-placeholders.md` (tests asserting degraded behavior)
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`, `45-durable-object-concurrency-mutex.md`
- `tasks/archive/2026-06-25-codex-refresh-scope-block.md` (#1412)
- `tasks/archive/2026-06-30-fix-production-codex-oauth-refresh-429.md` (#1439/#1445)
- codex-rs `login/src/server.rs` `build_authorize_url` (rust-v0.144.6) — login scopes
