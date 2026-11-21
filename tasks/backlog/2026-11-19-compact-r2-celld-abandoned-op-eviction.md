# compact-r2: an abandoned R2 operation blocks its key until the celld isolate retires

## Problem

`packages/project-data/src/archive/compact-r2.ts` keeps one provider operation in flight per
bucket/key (`timedR2`), and joiners wait through `joinR2Operation`. On the self-hosted celld
runtime, an operation whose starter request was dropped never settles, and its `.finally` cleanup
never runs. The entry stays in `pendingR2Operations`, so every later operation on that key fails
with `CompactArchiveTimeoutError` until the isolate is retired, which on a long-lived celld process
means until restart. On Cloudflare a provider operation always settles, so this cannot happen there.

Found by the security-auditor and architecture-reviewer on PR #2901 (L22a), MEDIUM. Deferred
because the behaviour is unchanged from main and from the integration branch the self-host box has
run for days. The compact archive runs from Durable Objects (whose ops survive on celld 0.6.3) and
from the cron sweep (no client to disconnect), so the dropped-starter case is not known to occur.

## Acceptance criteria

- [ ] Record `startedAt` on `PendingR2Operation`. Let a new caller replace an entry older than a
      bound derived from the archive R2 deadline plus a margin, only when the celld resume mode is
      on, so Cloudflare behaviour stays byte-identical.
- [ ] Confirm a re-issued PUT on the immutable content-addressed key is safe (identical bytes,
      reads verify `bodySha256`), or keep the refusal and surface the stuck key in a log/metric.
- [ ] Test: a pending entry older than the bound is replaced on celld and still refused on Cloudflare.
