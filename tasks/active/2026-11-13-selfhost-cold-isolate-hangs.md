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
     pending JWKS fetch per isolate.
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

- [ ] runtime-secrets: stop sharing the in-flight fetch across requests; cache only on success
- [ ] Live regression test through real celld: an aborted first request on a fresh isolate must
      not poison later requests (stateless and Durable Object); proven red before the fix
- [ ] Shared-flight joins elsewhere bounded by the joiner's own timer (admin settings caches),
      CF behaviour unchanged; unit tests
- [ ] project-data ensure memo: no cross-request join; unit test
- [ ] agent sign-in JWKS: bounded, recoverable join; unit test
- [ ] Before/after load numbers (same harness)
- [ ] Upstream celld issue text and minimal repro in PR body
- [ ] README "Cold starts" / troubleshooting updated
- [ ] CI green on branch (manual dispatch)

## Acceptance criteria

- [ ] With the fix, the abort probe leaves no hung request (stateless + DO) on real celld
- [ ] Load test after: zero requests >= 10 s that were not caused by the load itself
- [ ] Cloudflare behaviour unchanged (no new Worker vars; CF entry never imports selfhost code)
