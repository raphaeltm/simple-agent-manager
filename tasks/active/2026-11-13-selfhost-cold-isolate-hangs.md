# Self-host: one-minute request hangs on the celld box (H2)

## Problem

On the self-hosted single-VM install (celld 0.6.3, 2 vCPU test box), requests sometimes hang for
about a minute, or once for the full 300 s celld handler budget, with no restart. R4 saw eight
outages of 57-92 s in 45 minutes under load. Each began when two isolates cold-started together.
Only one of them logged `runtime_secrets.loaded`. The other hung its requests until it retired
and logged neither success nor `unavailable`. The same shape was seen before sealed secrets
existed (T14).

Evidence: idea `01M77QE3GR2JRA7DSQQENMJZDE` and its note; notes "BOX ROUND R4" and "BOX ROUND R3"
on idea `01M77AG90EQB4F9VAKDVH94ZK4`.

## Research findings (reproduced locally, not on the box)

Local reproduction ran in `.tmp/h2/repro/` (gitignored scratch): the pinned celld 0.6.3 image,
the pinned MinIO image and the key-agent image, each pinned to 2 CPUs, plus the real API Worker
deployed by the real `scripts/selfhost/deploy.ts`. It was tried in both sealed (`file`) and
`legacy-plaintext` modes.

1. **celld drops a request's async ops when that request ends or its client disconnects.**
   This is celld 0.6.3 source, read in `.tmp/h2/celld-src`:
   - `runtime.rs` ~2291-2323 clears the pending ops and deletes their resolvers on cancel, or
     when the response is done and nothing was passed to `waitUntil`.
   - `js.rs` ~3840-3856 refuses later work from a continuation of a retired request.
   - Timers (`setTimeout`, `AbortSignal.timeout`) are ops of the same kind, so the request's own
     abort timer is dropped too.
   - A request left waiting on a promise nothing will settle is re-polled every 10 ms until the
     handler budget runs out ("waiting on nothing", 300 s default).
2. **A per-isolate promise shared across requests therefore never settles once its initiating
   request's client disconnects.** Every later request that joins it hangs until its own client
   gives up or the 300 s budget runs out. The isolate retires only after those clients leave.
   - Minimal non-SAM reproduction: `.tmp/h2/upstream/` (13-line Worker).
   - SAM reproduction: abort one request on a fresh isolate. The next requests on that isolate
     hang (client cap 30 s) and log nothing.
3. **SAM has this pattern on hot paths:**
   - `apps/api/src/selfhost/runtime-secrets.ts`: the `inflight` secrets fetch shared by every
     request on a cold isolate. This is the R4 signature: no `loaded`, no `unavailable`.
   - `apps/api/src/services/admin-settings-cache.ts`: `AdminSettingsCache` `inFlight`.
   - `apps/api/src/services/admin-settings-resolution.ts`: `credentialCache` and `kvCache`
     pending entries. These sit on the auth/config path in both modes and are the likely
     pre-sealing (T14) cause.
   - `apps/api/src/services/project-data-ensure-memo.ts`: `inFlight`. A DO RPC with no deadline,
     so a joined dead flight never expires.
   - `apps/api/src/services/agent-sign-in/verify.ts`: jose `createRemoteJWKSet` keeps one
     pending JWKS fetch per isolate, but jose drops a pending fetch instead of joining it when it
     detects Workers (`WebSocketPair` or the `Cloudflare-Workers` user agent). celld defines both
     (`js/harness.js`), so this one is safe; no change.
   - Safe: `hosted-git/tokens.ts` caches a crypto key promise, but celld's WebCrypto settles it
     within the same turn (`js/crypto.js`).
4. **Who disconnects first on the box:**
   - the R4 poller (5 s timeout)
   - Caddy keep-warm (10 s `health_timeout`)
   - the deploy health check (10 s)
   - browsers navigating away

   A cold start under CPU load is slow enough to outlast these, which is why the outages
   clustered while backups, scans and deploys loaded the box.

## Implementation checklist

- [x] runtime-secrets: stop sharing the in-flight fetch across requests; cache only on success
- [x] Live regression test through real celld: an aborted first request on a fresh isolate must
      not poison later requests (stateless and Durable Object); proven red before the fix
- [x] Shared-flight joins elsewhere bounded by the joiner's own timer (admin settings caches),
      CF behaviour unchanged; unit tests
- [x] project-data ensure memo: join bounded by the joiner's own timer, then its own ensure; unit test
- [x] agent sign-in JWKS: checked, jose already avoids the join on celld (no change)
- [x] Before/after load numbers (same harness)
- [x] Upstream celld issue text and minimal repro in PR body
- [x] README "Cold starts" / troubleshooting updated
- [ ] CI green on branch (manual dispatch)

## Acceptance criteria

- [ ] With the fix, the abort probe leaves no hung request (stateless + DO) on real celld
- [ ] Load test after: zero requests >= 10 s that were not caused by the load itself
- [ ] Cloudflare behaviour unchanged (no new Worker vars; CF entry never imports selfhost code)

## Results (local, real celld 0.6.3 + real API Worker, 2-CPU cpuset under CPU+disk load)

| Run                                              | Mode   | Requests | Hung (>= 10 s or client cap) | Worst |
| ------------------------------------------------ | ------ | -------- | ---------------------------- | ----- |
| Natural load, 15 min, before                     | sealed | 2153     | 2 (150 s cap)                | 150 s |
| Natural load, 15 min, after                      | sealed | 2153     | 0                            | 2.8 s |
| Natural load, 15 min, before                     | legacy | 2153     | 0                            | 2.7 s |
| Natural load, 15 min, after                      | legacy | 2153     | 0                            | 2.6 s |
| Cold burst + impatient client, 10 cycles, before | sealed | 60       | 46 (9/10 cycles, 60 s cap)   | 60 s  |
| Cold burst + impatient client, 10 cycles, after  | sealed | 60       | 0                            | 2.8 s |
| Cold burst + impatient client, 10 cycles, before | legacy | 60       | 0                            | 4.3 s |
| Cold burst + impatient client, 10 cycles, after  | legacy | 60       | 0                            | 4.0 s |

The natural-load hangs needed no client abort: a burst of six requests produced two concurrent
isolate builds, and two requests hung with no Worker log line. celld clears a stateless request's
ops when it answers without `waitUntil`, so an answering starter drops a shared flight too. The
fix covers both triggers.

Not reproduced locally: a legacy-plaintext hang through unauthenticated routes. The
admin-settings join was proven through real celld by the live settings case instead.

## R6 follow-up: joiners resumed on the starter's turn (box round, 2026-11-13)

On the box (030a84ad8, Worker 4a179e1014d3d0f9, same bounded load as before the fix) the long
poller outages were gone, but 13 of 128 authenticated requests (`get-session` with a cookie,
`/api/projects`, project sessions) still hung to the 60 s client cap. Anonymous requests and
`/health` never hung.

Cause, reproduced on local real celld 0.6.3: when request B awaits a promise request A started,
B's continuation runs as part of A (the "continuation of a retired request" in finding 1). Every
timer, fetch or D1 call B makes afterwards is dropped as soon as A answers, with no client
disconnecting. The shared-flight timer only covers a flight that never settles. A healthy
settings flight joined by a concurrent authenticated request reproduces it every time.

Fix (branch `sam/r6-joiner-own-turn`):

- [x] `joinSharedFlight` on celld: the flight's settlement only records the outcome; the joiner
      wakes on its own 10 ms timer. Cloudflare keeps the direct resume (no added timer).
- [x] The generated celld entry turns the switch on at startup, in both key modes
      (`renderRuntimeSecretsMain`, new `renderPlainMain`; `deploy.ts` always uses `celld-main.ts`).
- [x] `platform-config-core.ts` joins through `settleSharedFlight` (review V1 M1).
- [x] Live test case: a healthy joined settings read followed by the joiner's own fetch and timer.
      Red without the switch (second request hung to the 15 s cap), green with it.
- [x] Unit tests: both runtimes for every existing case; own-timer resume (red on the old code);
      Cloudflare direct-resume control.
- [x] Box: deployed (dc0c53f08, Worker ed15e84b93a4bd41) and repeated the same 15 min load:
      0 of 128 requests hung (worst 4.6 s; #2706 alone: 13 of 128 to the 60 s cap). 30 min soak:
      0 poller failures in 3,599 probes. Details: idea `01M77QE3GR2JRA7DSQQENMJZDE`, note
      "BOX ROUND R6 (hang fix)".

## R7: reconcile with #2707 (F1) and verify on the box (2026-11-13)

#2707 converted the remaining unbounded joins (platform config, credential and legacy-KV rows,
the ensure memo, the setup-session alarm) to `joinSharedFlight` / `settleSharedFlight` and added
`pnpm quality:shared-flight-joins`. It did not change the helper itself, so the merge conflict was
only in `platform-config-core.ts` (both sides had converted the same join; F1's bounded-retry
version kept) and the live test (F1 moved it onto the shared celld lab).

Decision: every join needs the own-timer resume, and it gets it from the one helper. R6's
mechanism (a continuation belongs to the request whose op settled the promise) does not depend on
which flight was joined, and the live test below confirms it for each kind.

- [x] Merge `sam/selfhost-pass-2` (4cfbe497d) into `sam/r6-joiner-own-turn`; one helper, one
      behaviour (`apps/api/src/lib/shared-flight.ts`), every join goes through it.
- [x] Live test: one case per kind of join through its real code (settings cache, platform
      config, credential rows, legacy KV, ensure memo, archive R2 operation, a Durable Object
      field shaped like `CredentialSetupSession.resumeCleanup`). Join cases use a delay server
      that holds every request: the agent proxy holds only new connections, and a pooled
      connection once made the DO case's "slow" read instant.
- [x] Revert proof 1 (startup switch removed): the six stateless kinds went red (second request
      hung to the 15 s cap); the Durable Object case stayed green. On celld 0.6.3 an object's ops
      survive one of its requests answering, so that case is a labelled control.
- [x] Guard extended to the final pattern: a `.then`/`.catch`/`.finally` on a shared flight, a
      shared flight handed to any function other than the two helpers, and fields of a class with
      a module-scope instance (the admin-settings cache shape) are findings. Its new tests were red
      against F1's guard (3 of 10).
- [x] The extended guard found one more join: `compact-r2.ts` `timedR2` raced another caller's R2
      operation with its own timer, reachable from the stateless archive cron. Converted to the
      helper (`joinR2Operation`); Cloudflare semantics identical (same race, same error class).
      Revert proof 2 (only this conversion reverted): only the R2 live case went red.
- [x] F1's per-site abandonment tests and the compact-r2 join test run in both join modes.
- [ ] CI green on the branch (manual dispatch); Code Quality dependency-evidence failure cleared
- [ ] Box: backup, deploy, health, `secrets status`, `verify-fence`, R6 load + 30 min soak, smoke
