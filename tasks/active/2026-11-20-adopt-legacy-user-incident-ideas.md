# Adopt legacy incident ideas stored with triggered_by = 'user'

Follow-up found while verifying PR #2954 in production (task 01M7X5G8JTXYSGJTXHMDSTYNC3).

## Problem

PR #2938's hourly reconciliation adopts a legacy incident idea only when
`tasks.triggered_by = 'incident'`. Legacy pipeline ideas were stored with the column default
`'user'`: production on 2026-11-20 had 320 unowned legacy ideas with `'user'` (305 exact generated
shape) and only 1 with `'incident'`. They are never adopted, so `OPEN_TRACKED_WORK_SQL` counts each
as tracked work. All 12 pending error incidents were held back (`incident_dispatch_stalled`, reason
`tracked_work`), so no triage run dispatched after 20:01Z, and 282 expired incidents kept open
draft ideas that the reconciliation could not close.

## Fix

- Adoption selector accepts `triggered_by IN ('incident', 'user')`; every other check stays
  (exact generated title/body, draft, priority 0, triage link, no Durable Object engagement).
- In the same transaction, adoption rewrites `triggered_by` to `'incident'` (compare-and-set on the
  idea's `updated_at`, which it does not change), and records ownership only if that write landed,
  so `pipelineOwnsIdeaSql` holds afterwards.

## Checklist

- [x] Selector and adoption write
- [x] Test in the production row shape; reaches dispatchability; edited control; guards proven discriminating
- [x] Staging: reconciliation adopts staging legacy rows (70 -> 3 unowned 'user'; 63 ended ideas cancelled; dispatch resumed)
- [ ] Production: legacy ideas adopted, error incidents dispatchable, a triage run follows

## Throughput

At the default 25 per batch and 20 s deadline, the 305 production ideas clear in one or two
hourly runs (one Durable Object read per batch). Closing the 282 expired ones follows in the same
or next run, as #2938 intended (approved by Raphaël 2026-11-20).

## Last-write guard (Codex P1) — superseded by the follow-up below

A person's description edit leaves no record the engagement check reads. 'user' rows are adopted
only if never edited (`updated_at = created_at`) or last written in the hourly run's window
(:30-:34, `PLATFORM_FEEDBACK_HOURLY_CRON_MINUTE`), when the old pipeline refreshed them.
Production: 219 never edited, 75 at :30-:31, 11 at other minutes (stay tracked work).

## Residual risk (review)

Adoption checks the generated heading, summary sentence, closing fence, title, draft status and
priority 0, plus Durable Object engagement (links, notes, files, PRs). It does not compare the
full body, so a person's edit inside the body of a pipeline-created idea that keeps that shape
would be adopted and could later be closed with its incident, but only if that edit landed
inside the hourly run's 5-minute window (superseded: #2958 adopts never-edited rows only). Same check #2938 applies to
'incident' rows; every candidate is the pipeline's own idea (triage row link). Accepted.

The first reconciliation after deploy adopts the ~305 ideas and then cancels the ~282 whose
incidents ended, in batches of at most 25 within the 20 s deadline.

## Follow-up: never-edited only (2026-11-21)

Review after merge: the :30-:34 last-write window correlates with pipeline writes but does not
prove the writer (rule 74). A person's edit inside the fence at :31 would be adopted, then
rewritten on recurrence or closed with its incident. The follow-up removes the window: a 'user'
row is adopted only when `updated_at = created_at`. Regression: an edit inside the fence at :31
is not adopted; positive control: a never-edited automatic idea is adopted.

Production exposure while #2957 is live (API Worker version for 268186d8 active from 01:21:36Z;
the cancel of deploy run 44848715648 arrived 8 s too late): 86 'user' rows last written at
:30-:34 (68 expired, 18 pending) are adoptable by the 01:30Z run. Evidence they were pipeline
writes: shared millisecond `updated_at` values across ideas (batch writes) and template-length
bodies. Recovery point if any must be restored: D1 Time Travel before 2026-11-21T01:30Z.

## Production outcome (2026-11-21 01:30Z, #2957 code)

All remaining legacy draft ideas were adopted, including the 86 window-rule rows. A
pre-run snapshot of those 86 (Library /engineering/incident-idea-adoption-snapshot-2026-11-21.json)
found no evidence of a user edit: every body, normalized (ids, timestamps, numbers, evidence lines), matches the generated template and embeds its own signature ref, with no user status
events. Edits that change only those normalized values are not ruled out. 100 ended incidents' ideas were closed in that run.
