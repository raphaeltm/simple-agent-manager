# Self-host: a request aborted on a cold celld isolate can hang the next request on it

## Problem

On the celld runtime, when a browser aborts a request that landed on a freshly started stateless
isolate, the next request on that isolate can stall past its own deadlines and answer nothing
until its client disconnects. Seen twice in T12 with `GET /api/github/installations` as the test
account (12:16:40Z and 12:19:09Z): the aborted request logged 500 after ~60 ms
(`incomplete_message`), the probe logged its GitHub token lookup, then none of its GitHub fetch
responses and no 504 from the route's 15 s `withDeadline`, and ended only when curl gave up
(23.6 s, 18.6 s). A warm isolate never reproduced it (40+ aborts). It is separate from the
per-user token-lock wedge fixed in #2653: the lock answered.

[I] Likely the same celld mechanism as #2653: `cancel()` -> `entry.abandon()` drops a cancelled
event's op resolvers without settling them (`crates/celld/js.rs`, v0.6.3). Here the stranded
promise is isolate-shared state (a lazily created client or memoized promise) that a later
request awaits. Not proven which one.

## Context

Self-host pass 2, task T12 (01M756Q9BG0NEWNK1YV05453C7). Repro: `~/t12/sweep.sh` and the cold
trials on the box (idle 40 s so the isolate retires, then `curl -m 0.1` followed by a probe).
Isolates retire after ~8 s idle (see `2026-11-11-selfhost-celld-isolate-cold-start-slow-page-loads.md`),
so a user's first request after a pause often runs on a cold isolate, and navigating away
mid-request is common.

## Acceptance Criteria

- [ ] Identify the stranded shared promise (instrument the cold path, or bisect with a probe
      Worker on `celld dev`).
- [ ] Report upstream to denoland/celld with a minimal Worker: abandoned ops should reject, not
      vanish, or shared state should not be bound to the cancelled event.
- [ ] Decide (human) on a SAM-side mitigation if upstream is slow (for example, Caddy keeping
      upstream requests alive after client disconnect, if possible, or `ctx.waitUntil` on the
      shared initialisers that are identified).
