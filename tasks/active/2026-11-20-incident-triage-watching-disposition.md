# Incident triage: WATCHING disposition, spike escalation, quiet expiry

SAM task 01M7X5G8JTXYSGJTXHMDSTYNC3 (dispatched by 01M7W24S5P134JQECZDRDKKRWG). Design approved
by Raphaël 2026-11-20 (knowledge entity SelfDebuggingSystem). Builds on PR #2938 (idea
01M2CKJMNNE0FGASV18J0GFRAT).

## Problem

`resolve_incident` accepts only `resolved` / `rejected`. A resolved signature that recurs reopens
to `pending` after the 30-minute cooldown (`shouldReopenExistingTriage` → `shouldReopenIncidentForOccurrence`),
so "wait and see" means re-triaging the same error every time it repeats: tokens burnt, no
frequency picture for a weekly builder.

## Research findings

- `queue_state` has no D1 CHECK constraint (migration 0119 adds it as plain TEXT). A new value
  needs no table recreation; new columns are additive `ALTER TABLE ADD COLUMN`.
- Predicates over `queue_state` (rule 79 audit):
  - allowlists that must exclude watching (and do by construction): dispatch (`listDispatchableIncidentQueue`,
    `hasDispatchablePendingIncidents`, `reserveIncidentDispatch`, `explainUndispatchableIncidents`,
    `incident_dispatch_stalled`, `pending_incident` anomaly), claim (`claimIncident` pending/dispatched),
    max-age and stale-singleton expiry (pending/dispatched/claimed and pending), idea close
    (`closeEndedIncidentIdeas` terminal set), reopen (`['resolved','expired']`), budget-deferred loader (pending).
  - `list_incident_queue` default `['pending','dispatched','claimed']`: watching stays out of the
    default, available by filter.
  - negative forms: `retitleLegacyIdeas` `NOT IN terminal` (watching should be retitled: correct),
    runner `queued_at IS NULL AND queue_state NOT IN ('resolved','expired')` (watching rows bypass
    this UPDATE), user-report `queued_at ... NOT IN` (keeps watching row watching, counts +1: fine).
  - `range-report.ts` OPEN_INCIDENT_STATES + shared `InstallationLatencyIncidentState`: a watched
    latency incident is still an open defect → add `watching`.
  - Admin UI: no web surface renders incident queue states (LatencyPane shows only counts/link).
- `occurrence_count` in the runner is `MAX(stored, window count)` (overlapping 60-min windows),
  not a running total. Watching needs exact increments: count only error timestamps newer than the
  stored `last_seen_at`, compare-and-set on `last_seen_at`.
- Settings belong in the admin settings registry (`fleet-ops/settings-definitions.ts`, rule 07).

## Representation decision

New `queue_state = 'watching'` (not a resolve outcome + marker). Every existing predicate is an
allowlist of `pending/dispatched/claimed` or of `resolved/rejected/expired`, so a distinct state is
excluded from dispatch, reopen and idea-close by construction. A `resolved` + marker would have to
be carved out of reopen, idea-close and the latency report individually (rule 67: never widen a
shared predicate that drives an action).

## Checklist

- [x] Migration 0264: `watching_since`, `watch_reason`, `watch_hourly_counts` (JSON epoch-hour → count), `watch_escalated_at`, `watch_escalation_reason`; schema.ts
- [x] `INCIDENT_QUEUE_STATES` gains `watching`; neither active nor terminal
- [x] Settings: recent window hours (168), spike window hours (24), spike min occurrences (50), spike baseline multiplier (3), quiet expiry hours (336)
- [x] `watchIncident` (claimed → watching, requires note, resets dispatch_attempts, keeps buckets)
- [x] `resolve_incident` outcome `watching` (tool definition + handler)
- [x] Runner: watching rows record exact new occurrences into hourly buckets, CAS on last_seen_at, refresh the owned idea, never reopen / diagnose / claim
- [x] Spike: count since max(now − spike window, watching_since) ≥ min and ≥ multiplier × baseline → pending with reason, queued_at = now
- [x] Quiet expiry after recurrences in the hourly run; existing idea close cancels the idea
- [x] Read surface: list_incident_queue / get_incident return watchingSince, watchReason, recentOccurrenceCount, recentWindowHours, escalatedAt, escalationReason; `sort: "frequency"`
- [x] Backlog summary line names a spike re-queue reason
- [x] Idea body shows disposition and recent count
- [x] range-report + shared type include watching
- [x] Trigger template (code default) gains FIX NOW / WATCHING rules
- [x] Tests (runner path, spike + control, expiry + control, resolved still reopens, MCP, real SQL), discrimination checks
- [x] Docs: reporting-issues.md, admin-settings.md
- [ ] (post-deploy, this task) Live trigger 01M0Y4KTQAVKTG7VVWNWXD89Y8 updated after production deploy

## Throughput (rule 81)

Recurrence handling is one read + one CAS UPDATE per watched group, inside the existing group limit
(5/hour). Quiet expiry is one UPDATE per hourly run, unbounded set but single statement on an
indexed state column. Buckets ≤ recent window hours (168 keys default, 720 max) per row.

## Acceptance criteria

- A watched signature recurring through the runner updates counts and does not reopen or dispatch.
- A spike above threshold re-queues with a reason; below threshold stays watching.
- A quiet watched signature expires and its idea is cancelled; a recurring one does not expire.
- A resolved (not watched) signature still reopens as before.
- list_incident_queue filters to watching with frequency fields.
- Production: live template has the rules; a run marks a signature watching; later recurrence updates counts; list returns frequency fields.
