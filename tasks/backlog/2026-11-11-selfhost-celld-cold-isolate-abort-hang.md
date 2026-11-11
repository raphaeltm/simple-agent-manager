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
Isolates are retired on celld's 30 s pool tick whenever no turn is running (corrected in T14; see
`2026-11-11-selfhost-celld-isolate-cold-start-slow-page-loads.md`), so a user's first request after a pause often runs on a cold isolate, and navigating away
mid-request is common.

## T14 evidence: the same hang with no client abort (2026-11-11, Caddy access log)

The access log added in T14 recorded the whole lifetime of one stuck request:

- 16:22:53.94Z celld started isolate 49 in stateless slot 1 (a second isolate, cold) for the
  burst of requests a project-chat navigation sends. Slot 0 was the warm keep-warm isolate.
- 16:22:54.5Z `GET /api/credentials/agent` (test account, preflight 204 at 16:22:54.49). SAM never
  logged an `http.request` line for it, so the handler did not finish.
- 16:23:35Z the pool tick marked isolate 49 retiring; `may_free` refused to free it while the
  request held its affiliation.
- 16:27:54.647Z Caddy logged `GET /api/credentials/agent 500` with `duration` 300.088 s; at
  16:27:54.657Z celld logged `isolate freed isolate=49`. 300 s is celld's default handler budget
  (`CELLD_HANDLER_BUDGET_S` unset on the box).
- The browser saw a CORS failure (celld's 500 carries no CORS headers); the UI's retry at
  16:27:55 returned 200 in 14 ms.

So the client did not abort, and the request was not slow: it hung on a freshly started second
isolate until celld's budget. This narrows the trigger to "first requests dispatched onto an
isolate while it is cold-starting", with or without a disconnect. Repro hint: force slot 1 by
sending ~10 concurrent requests right after a pool tick, then look for access-log entries with
`duration` near 300.

## Acceptance Criteria

- [ ] Identify the stranded shared promise (instrument the cold path, or bisect with a probe
      Worker on `celld dev`).
- [ ] Report upstream to denoland/celld with a minimal Worker: abandoned ops should reject, not
      vanish, or shared state should not be bound to the cancelled event.
- [ ] Decide (human) on a SAM-side mitigation if upstream is slow (for example, Caddy keeping
      upstream requests alive after client disconnect, if possible, or `ctx.waitUntil` on the
      shared initialisers that are identified).
