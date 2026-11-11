# Self-host: celld cold-starts the Worker on almost every navigation (slow project loads)

## Problem

On the celld self-host box (`app.vmtest.sam2.party`, celld 0.6.3), page loads after a short pause take 2-4 s, and sometimes two cold starts in a row.

celld's stateless isolate pool retires one isolate that hosts no cells on every 30 s pool tick whenever no JS turn is running at that instant (`REAP_INTERVAL` in `crates/celld/runtime.rs` and `celld_logic::isolate::retire` in `crates/logic/isolate.rs`, v0.6.3; corrected in T14, which read the source: idleness does not matter, and an isolate started 1.7 s before a tick was retired at it). The next request then waits while a new isolate loads the 29 MB SAM bundle, which takes about 1.5-2.2 s. The web app (`app.*`, served by the same Worker through `ASSETS`) and the API (`api.*`) both pay this.

## Context

Found in T11 (task `01M74ZTZJWPZ80YXPG85MAJHJ8`, 2026-11-11). Raphaël reported "a weirdly long time to load the project" after a fresh GitHub sign-in.

Measured on the box:

- Unauthenticated `GET /api/projects`: 1.69 s cold vs 0.14-0.19 s warm.
- Project page in a real browser after 70 s idle: the HTML document alone took 2.21 s, and the project name rendered at 4.2 s. Warm, the page is complete at ~2.7 s.
- Isolate 190 started at 10:02:28.25, served 2 requests, and was retired at 10:02:36.08.
- Server handler times stay small: project GET 140 ms, sessions 52 ms, ProjectData DO isolate start ~2 ms.

celld 0.6.3 has no setting for stateless isolate idle retirement. `CELLD_IDLE_EVICT_S` covers cells (DOs) and is off by default; `CELLD_MAX_STATELESS_ISOLATES` appears only in the list of removed settings.

Not explained: in Raphaël's window his browser sent no project request at all between 09:43:20 and 09:44:16Z. Caddy has no access log and celld does not log `app.*` document or asset requests, so that minute cannot be traced.

Separately, and not self-host specific: `GET /api/github/installations` syncs live with GitHub on every call (0.8-1.5 s).

## Acceptance Criteria

- [ ] Decide the fix: upstream celld (keep N warm isolates, or an idle-retirement setting) vs a box-level keep-warm vs accepting it
- [ ] Caddy access logging (or celld request logging for `app.*`) on self-host boxes, so slow-load reports can be traced
- [ ] After the fix, a cold navigation to a project page on the box renders the project in under ~1.5 s

## Stopgap shipped (T14, 2026-11-11)

Caddy keeps one isolate warm with an active health check (`deploy/selfhost/caddy/keep-warm/on.caddy`,
`SAM_KEEP_WARM`, `SAM_KEEP_WARM_INTERVAL`, README "Cold starts"). This task stays open for the
upstream celld fix: keep a minimum number of warm isolates, or an idle-retirement setting. The
stopgap keeps only the isolate the ping lands on; a burst that needs celld's second slot can still
pay a cold start (seen once in the T14 baseline: 1,630 ms on a warm-phase request). Pings cannot
stop a tick's retirement; they only make the next ping, not a user, pay the restart. Measured:
1 of 14 first-requests-after-idle cold with keep-warm at 5 s, vs 8 of 8 before. The upstream ask
is therefore specific: keep at least one warm stateless isolate (a `min_stateless`), or retire only
isolates idle longer than a configurable age.
