# Restart private incident triage; readable, self-cleaning incident ideas

SAM task 01M7W379QC0RM803FKN8GEG6WN. Idea 01M2CKJMNNE0FGASV18J0GFRAT. Parent 01M7W24S5P134JQECZDRDKKRWG.
Raphaël decided 2026-11-20 to restart automated incident triage and accept its token spend.

## Problem

- The hourly diagnosis runner (`platform-feedback-triage/runner.ts`) and the user-report path
  (`platform-feedback-incidents/user-report.ts`) create a draft idea per signature and store it in
  `platform_feedback_triages.idea_id`. `OPEN_TRACKED_WORK_SQL` (`platform-feedback-incidents/selection.ts`)
  counts any non-terminal linked idea as tracked work, so every incident is excluded by its own auto-idea
  and `runIncidentTriggerSweep` breaks at `pendingCount = 0` without logging.
- Auto-ideas are titled `Recurring <source> platform error` (`grouping.ts`) with only error IDs in the body.
- Auto-ideas are never closed when the incident ends.
- Triage runs on 2026-11-03/04 (01M6J75AW75ACFFYQ60E5KPHS4, 01M6J3FAQ1SNNP8NJA0WR3C1QP) posted a final
  message but never called `complete_task`; the template told them to "leave it claimed and report via
  update_task_status". They stayed non-terminal for 7 days (skipIfRunning + maxConcurrent=1 blocked the
  trigger) and were cancelled on 11-11.

## Consumers of OPEN_TRACKED_WORK_SQL / idea_id (rules 58, 66, 67)

- `queries.ts listDispatchableIncidentQueue`, `queries.ts hasDispatchablePendingIncidents`,
  `dispatch.ts reserveIncidentDispatch` — all three gate dispatch; must share one predicate.
- `queries.ts listIncidentQueue` / `prioritization.ts` / `persistence.ts` — ordering only (diagnosed first/last).
- `runner.ts` — "idea exists → update description", claim requires `idea_id IS NULL`.
- `user-report.ts` — creates/updates report ideas.
- `lifecycle-latency/range-report.ts` — read-only display.
- `getIncidentDetail` — returns ideaId to the triage agent.

## Design

- New column `platform_feedback_triages.idea_owned_at`: the `tasks.updated_at` value the pipeline last
  wrote to its idea. The pipeline owns the idea iff `tasks.triggered_by='incident'` and
  `tasks.updated_at = idea_owned_at`. Any edit, status change or priority change by a person or agent
  moves `updated_at` and ends ownership. DO-only engagement (strong session links, notes, PR/file links)
  is checked directly through `getIdeaWorkSnapshots` before dispatch and before cleanup; an engaged idea is
  released (`idea_owned_at = NULL`) so it counts as tracked work from then on.
- `OPEN_TRACKED_WORK_SQL` ignores a pipeline-owned idea; promoted/edited/linked ideas still count.
- Titles: `<source>: <case-preserved normalized, redacted message>` bounded; body has normalized message,
  occurrence count, first/last seen. Signature hashing unchanged.
- Re-occurrence updates the owned idea (title, body; reopens a pipeline-cancelled idea).
- Reconciliation sweep (hourly, deadline bounded): cancel owned draft ideas whose incident is
  resolved/rejected/expired; adopt legacy untouched `Recurring … platform error` ideas (no fingerprint)
  after a DO engagement check; retitle pending legacy rows from a representative error message.
- Stall anomaly `incident_dispatch_stalled` in `ops_find_anomalies`; sweep logs a reason breakdown when
  pending incidents exist but none are dispatchable.
- Trigger template (code default + live trigger): always end with `complete_task`.

## Checklist

- [x] Migration: add `idea_owned_at` column (ADD COLUMN only)
- [x] Shared ownership SQL + tracked-work predicate change
- [x] Readable title/body (grouping.ts) and summary refresh on re-occurrence
- [x] Runner create/update writes fingerprint; updates only owned ideas; reopens pipeline-cancelled idea
- [x] User-report path writes fingerprint; updates only owned ideas
- [x] Release engaged ideas (DO snapshot) before dispatch
- [x] Reconciliation sweep: cancel terminal-incident ideas, adopt/retitle legacy ideas, deadline bounded
- [x] Sweep decline-reason logging + stall setting
- [x] Anomaly class `incident_dispatch_stalled`
- [x] Backlog summary neutralizes untrusted summary text
- [x] Trigger template: complete_task at the end
- [x] Tests on real SQLite: self-blocking regression, promoted/edited/linked still block, titles, one idea
      per signature, cleanup never touches edited/linked ideas, stall anomaly, decline log
- [x] Docs updated
- [ ] Post-deploy: update live trigger template, verify trigger fires, run completes, queue drains

## Acceptance criteria

- Pending incidents whose only link is their own untouched auto-idea are dispatchable.
- Ideas promoted, edited, or linked to work still block dispatch.
- New/updated auto-ideas are titled from the normalized redacted signature.
- Re-occurrence never creates a second idea for the same signature.
- Owned draft ideas are cancelled when their incident is terminal; edited/linked ideas never touched.
- Stalled pending incidents appear in `ops_find_anomalies`; the sweep logs why it declined.
- Production: trigger fires, a triage run completes, the queue drains, no new generic titles.

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2938](https://github.com/raphaeltm/simple-agent-manager/pull/2938), followed by #2954, #2957 and #2958. Line 65 is partly evidenced: the trigger fires (32 runs, last 2026-11-22T14:05Z) and runs complete (triage tasks 01M81S6T8FX36JY529HN7J409X and 01M814KQD60ZCE0JXQV8M1WCQ3 on 2026-11-22). The template update and queue drain were not re-checked, so it stays unticked.
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
