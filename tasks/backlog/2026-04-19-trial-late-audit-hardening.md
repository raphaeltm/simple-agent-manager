# Trial Onboarding — Late-Audit Hardening Follow-ups

## Problem

After PR #760 merged, a late-arriving security audit returned with findings. Two were stale (already fixed in the merged branch). The rest are non-exploitable hardening items worth addressing before `sam/trial-onboarding-mvp` merges to `main`.

## Context

- Late audit task-id: `a35608e033ac4405a` (returned 2026-04-19, after PR #760 merged)
- The audit ran against a pre-remediation commit; CRITICAL-1 (no rate limit) and HIGH-1 (fingerprint HMAC verify) had already been fixed in `a696fb82` and `c9d46d02` respectively.
- None of the remaining findings are actively exploitable in the current state.

## Findings to Address

### HIGH-3 — `SameSite=Lax` on claim cookie

`apps/api/src/services/trial/cookies.ts:196` sets `SameSite=Lax` for both fingerprint and claim cookies. The claim cookie is functionally a bearer credential ("I own this trial project"). The auditor recommends `SameSite=Strict`.

**Acceptance criteria**:
- [ ] Verify the OAuth claim flow works end-to-end with `SameSite=Strict` on the claim cookie (github.com OAuth callback → api.sammy.party → app.sammy.party/try/:id?claim=1 → `POST /api/trial/:id/claim`)
- [ ] Keep fingerprint cookie at `Lax` (needs to survive cross-site OAuth initiation)
- [ ] Staging test with the actual OAuth flow — unit tests cannot validate browser cookie semantics
- [ ] If Strict breaks the flow, document the specific navigation that requires Lax and keep it

### HIGH-4 — `trial.ready` `workspaceUrl` derived from KV-backed record

`apps/api/src/services/trial/bridge.ts:41-43` falls back to `record.workspaceId` from KV when `opts.workspaceUrl` is absent. If the KV mirror write lagged or failed, `workspaceUrl` emits as empty string.

**Note**: The auditor's cross-trial wiring concern is invalid — `readTrialByProject` is keyed by unique `projectId`, not fingerprint. The real impact is a potentially-empty `workspaceUrl` field, which is a reliability/UX issue, not security.

**Acceptance criteria**:
- [ ] Change the ACP bridge call sites to always pass `workspaceUrl` explicitly (the caller has the workspace record in scope)
- [ ] Remove the KV-derived fallback or log a warning when it fires

### MEDIUM-2 — Sentinel installation trust assertion

`apps/api/src/durable-objects/trial-orchestrator/helpers.ts:31-36` inserts trial projects under `resolveAnonymousInstallationId(env)` — the sentinel row. If this row is ever mapped to a real GitHub App installation (misconfiguration), trial projects inherit that installation's permissions.

**Acceptance criteria**:
- [ ] Add a startup/migration-time assertion that the sentinel row has null/sentinel credentials (no real `access_token`)
- [ ] Document in `docs/architecture/trial-orchestrator.md` that the sentinel row must never map to a real installation
- [ ] Consider env var `TRIAL_INSTALLATION_IS_SENTINEL=true` as a startup check

### MEDIUM-1 — `TrialOrchestrator.getStatus()` RPC access control (hypothetical)

`getStatus()` is not currently exposed over HTTP. The auditor flagged this as future risk if an admin route is ever added.

**Acceptance criteria**:
- [ ] Add a code comment on `getStatus()` in `trial-orchestrator/index.ts` warning against unauthenticated HTTP exposure
- [ ] If admin status endpoint is needed in future, must be gated by `requireAdmin()`

### LOW items (defer to backlog-of-backlog or close as won't-fix)

- LOW-1 — `trial.ready` `workspaceUrl` disclosure to SSE subscriber: inherent to design (anonymous trial before claim). Document in architecture.
- LOW-2 — `timingSafeEqual` length oracle: migrate to `crypto.subtle.verify()` in general cookies refactor (not trial-specific).
- LOW-3 — GitHub API unauthenticated 60 req/hour: already documented; may use GitHub App token when operator sets one.

## Out of Scope

- CRITICAL-1, HIGH-1 (stale; already fixed in PR #760)
- HIGH-2 (KV rate-limiter atomicity): already deferred with documented rationale; superseded by general migration away from KV rate limiting

## Additional Findings — Cloudflare Configuration Audit (task `ae38c1e0689c9261e`, 2026-04-19)

A second late-arriving review (Cloudflare-focused) returned after PR #760 merged. None are actively user-impacting (staging verification observed 12 SSE events + 3-stage progression), but they are worth addressing before `sam/trial-onboarding-mvp` merges to `main`.

### HIGH-CF-1 — `advanceToStep` sequencing: `put('state')` → `setAlarm(now)` without atomic pairing

`apps/api/src/durable-objects/trial-orchestrator/index.ts:270-271`. If the DO evicts/crashes between `put` and `setAlarm`, state advances but no alarm is scheduled — trial hangs until an external nudge. Since `alarm()` re-reads state at the top of each handler, the safe mitigation is to swap the ordering so a crash re-runs the previous step rather than parking the machine silently.

**Acceptance criteria**:
- [ ] Swap to `setAlarm(now)` BEFORE `storage.put('state', ...)` at every call site where the two are paired
- [ ] Add a regression test that asserts alarm scheduling survives simulated put failures

### MEDIUM-CF-1 — SSE `ReadableStream.cancel()` leaks in-flight long-poll on client disconnect

`apps/api/src/routes/trial/events.ts:143-145`. `cancel()` is a no-op comment; the `heartbeat` `setInterval` and in-flight `busStub.fetch()` keep running until the poll times out (up to 15s). Bounded leak, no correctness issue, but each disconnect wastes a DO request slot.

**Acceptance criteria**:
- [ ] Set `closed = true` inside `cancel()` and clear the heartbeat interval
- [ ] Use `AbortController` to abort the in-flight DO fetch on cancel

### MEDIUM-CF-2 — `eventsUrl` response field is malformed (latent — frontend bypasses it)

`apps/api/src/routes/trial/create.ts:394` returns `eventsUrl: /api/trial/events?trialId=...` but the actual route is `GET /:trialId/events`. **Staging works** because the frontend (`apps/web/src/lib/trial-api.ts:154`) ignores `eventsUrl` and constructs `${API_URL}/api/trial/${trialId}/events` directly. But any future consumer that honors the advertised `eventsUrl` will hit 404.

**Acceptance criteria**:
- [ ] Either: update `eventsUrl` in `create.ts` to `https://api.${env.BASE_DOMAIN}/api/trial/${trialId}/events` (absolute, matches route)
- [ ] Or: remove `eventsUrl` from the response shape entirely if the frontend is the only consumer
- [ ] Add a test asserting the returned `eventsUrl` resolves to a live route

### LOW-CF-1 — `trial.started` event emitted AFTER `setAlarm(now)` can race with subsequent step events on eviction

`apps/api/src/durable-objects/trial-orchestrator/index.ts:107-119`. If the DO is evicted after `setAlarm` but before `safeEmitTrialEvent(trial.started)` completes, the started event is lost and the UI never shows the "warming up" → "started" transition. Not a data loss; step events still flow.

**Acceptance criteria**:
- [ ] Emit `trial.started` BEFORE `setAlarm(now)` in `start()`, or move emission to the first alarm handler where persistence is guaranteed

### LOW-CF-2 — `TrialOrchestrator` wrangler migration uses `new_classes` (not `new_sqlite_classes`)

Currently correct — the DO only uses `ctx.storage.put/get`, not `ctx.storage.sql`. Flagged as a maintenance trap because a future contributor adding `ctx.storage.sql` would silently get an uninitialized SQLite without bumping the migration.

**Acceptance criteria**:
- [ ] Add a comment to the `v9` migration block in `wrangler.toml` explicitly stating: "intentional: TrialOrchestrator is KV-only. If adding `ctx.storage.sql`, switch to `new_sqlite_classes` AND bump the migration version."

### LOW-CF-3 — `TrialEventBus` is designed for single-viewer

`apps/api/src/durable-objects/trial-event-bus.ts`. Waiters are independent (per-poll timers + resolve pairs), so multi-viewer works correctly, but it's not documented. Add a comment.

**Acceptance criteria**:
- [ ] Add a class-level doc comment noting the single-consumer design intent and confirming multi-consumer works because waiters are independent

## Out of Scope (Cloudflare Audit)

- MEDIUM-CF-3 (KV rate-limit race on `POST /api/trial/create`): already listed as HIGH-2 deferred above; same disposition — acknowledged tradeoff, atomic `TrialCounter` DO still protects the monthly cap from overshoot.

## Additional Findings — Second Security Audit (task `a1dafc59ceab016f4`, 2026-04-19)

A third late-arriving review (security-focused re-audit) returned. Multiple findings duplicate earlier audits or are stale (ran against a pre-fix commit). New items worth tracking:

### MEDIUM-SEC-1 — No rate limit on `GET /api/trial/:trialId/events`

SSE endpoint holds Worker subrequests open up to 30 min each. A single IP could open many concurrent connections against different (possibly-guessed) trialIds. Per-IP limit recommended.

**Acceptance criteria**:
- [ ] Apply `rateLimitAnonymous` or a dedicated `rateLimitTrialEvents` factory to the events route
- [ ] Staging test: confirm normal SSE flow not affected by the limit

### MEDIUM-SEC-2 — README response body not byte-capped in `fetchText()`

`apps/api/src/services/trial/github-knowledge.ts:177-192`. `resp.text()` buffers entire body; very large READMEs could cause Worker memory pressure. AbortController timeout exists but no byte cap.

**Acceptance criteria**:
- [ ] Add `TRIAL_KNOWLEDGE_README_MAX_BYTES` env var (default 64 KB)
- [ ] Stream body via `Response.body` reader; abort when cap exceeded

### LOW-SEC-1 — `clearClaimCookie()` doesn't mirror `Domain` attribute set during issuance

`apps/api/src/services/trial/cookies.ts:226-233` vs `claim.ts:119`. Issuance may set `Domain=.${BASE_DOMAIN}`; clear defaults to host-only. Browser keeps the domain-scoped original cookie until natural expiry. Low impact (D1 precondition prevents double-claim) but cookie accumulates.

**Acceptance criteria**:
- [ ] Pass `cookieDomain` through to `clearClaimCookie()` in `claim.ts`

### LOW-SEC-2 — `TRIAL_CLAIM_TOKEN_SECRET` absent surfaces as 503 rather than startup-time observability

`apps/api/src/env.ts:450`. Fail-closed posture is correct, but operator error is only visible via runtime 503s.

**Acceptance criteria**:
- [ ] Emit a structured ERROR log on first trial request when `isTrialsEnabled` is true but `TRIAL_CLAIM_TOKEN_SECRET` is absent (one-shot dedupe)

### LOW-SEC-3 — `GET /api/trial/status` and `POST /api/trial/waitlist` unauthenticated with no per-IP rate limit

`status.ts:27` invokes `TrialCounter` DO on every call with no caching; `waitlist.ts:30` accepts emails from anonymous visitors. Both benefit from `rateLimitAnonymous`.

**Acceptance criteria**:
- [ ] Apply `rateLimitAnonymous` to `GET /api/trial/status` and `POST /api/trial/waitlist`
- [ ] Optionally: cache `{ count, enabled }` in the status handler's module-scoped cache alongside the kill-switch TTL

## Out of Scope (Second Security Audit — Stale or Duplicate)

- **HIGH #1 (rate-limit non-atomic)** — duplicate of HIGH-2 / MEDIUM-CF-3 already deferred with documented rationale; atomic `TrialCounter` DO still protects monthly cap.
- **HIGH #2 ("eventsUrl 404s every trial")** — the "returns 404" claim is STALE. Staging Phase 6 observed 12 SSE events working because the frontend (`apps/web/src/lib/trial-api.ts:154`) bypasses `eventsUrl` and constructs `${API_URL}/api/trial/${trialId}/events` directly. Contract-hygiene issue tracked as MEDIUM-CF-2.
- **MEDIUM #1 (`SameSite=Lax` on claim cookie)** — duplicate of HIGH-3.
- **MEDIUM #2 (unverified fingerprint extraction in create.ts)** — **STALE**. Auditor reviewed lines 273-280; the actually-merged code at lines 288-290 calls `verifyFingerprint(existingFp, secret)` (fix landed in commit `c9d46d02` and was confirmed by the first security audit's own verification pass). No action.

## References

- Merged PR: #760
- First security audit task: `a35608e033ac4405a`
- Cloudflare audit task: `ae38c1e0689c9261e`
- Second security audit task: `a1dafc59ceab016f4`
- Disposition comments: see PR #760 conversation thread
