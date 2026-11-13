# Bound a durable provisioning attempt that no longer honours the attempt deadline

## Problem

Since the tunnel hardening work (`tasks/archive/2026-11-10-tunnel-transport-hardening.md`), a
durable direct-provisioning attempt (`NodeLifecycle`, `node-lifecycle-provisioning.ts`) no longer
cancels the provider create, recovery or publish tail with its attempt deadline: cutting them
stranded created VMs on GCP. Each provider request still has its own timeout, but the attempt as a
whole is unbounded. Review findings (cloudflare-specialist, round 2):

1. **No ceiling on one attempt (rule 47 req. 5, rule 81).** A GCP create can stack firewall ensure
   (3-6 requests × 30 s), the insert, the operation poll (up to 5 min) and the machine-type lookup:
   roughly 10-13 min in the worst case. `alarm()` re-arms and returns while `inFlight` is true,
   before the max-age and max-attempts checks, so an attempt that never settles keeps the DO
   re-arming every 30 s with no residence bound.
2. **The public-IP DNS create keeps the elapsed attempt signal.** By then a GCP create has already
   outlived the 5 s deadline, so a non-tunnel durable GCP node's DNS create aborts at once and costs
   at least one more 30 s attempt (recovery, then DNS again under the same clock). Pre-existing on
   `main` in a worse form, because there the whole create ran under the deadline. Tunnel nodes have
   no DNS step on this path.
3. `ctx.waitUntil(this.run(...))` in a Durable Object: confirm whether the detached run survives
   past the request on staging (tail for completion beyond 30 s).

## Acceptance Criteria

- [ ] An env-configurable `DEFAULT_*` ceiling for a durable attempt. When it is exceeded, the
      attempt stops being awaited without cancelling a POST that was already sent, and the next
      attempt reconciles.
- [ ] The `inFlight` early return honours the intent's max age.
- [ ] The DNS create in the durable publish tail gets a fresh per-request timeout instead of the
      elapsed attempt signal, with a test using realistic create latency (more than 5 s).
- [ ] An overlapping-alarm test: an alarm fires while an uncancelled create is in flight.
