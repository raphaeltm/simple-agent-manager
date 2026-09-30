# Investigate repeated no-op ProjectData storage alarms on staging

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** three ProjectData alarm-cadence fixes landed after this observation. None was
>   checked against the two projects below, so they are the likely cause, not a confirmed one.
>   - PR #2083 (`1d15a7645`) clamps every storage-safety alarm term to at least now + 60 s
>     (`apps/api/src/durable-objects/project-data/storage-safety-alarm-time.ts:26,67`, test
>     `apps/api/tests/unit/durable-objects/storage-safety-alarm-schedule.test.ts`). Before it, a
>     never-run or stale cleanup marker made the scheduler return `now`, re-arming the alarm at once.
>   - PR #2144 (`1c7420585`) runs only the alarm sections that are due and logs every tick as
>     `project_data.alarm.completed` (`apps/api/src/durable-objects/project-data/alarm-sections.ts`).
>   - PR #2170 (`964035544`) backs off inconclusive workspace idle checks (a separate 60 s loop).
> - **Still open:** one bounded staging check of `01KY2QCEC2FEFDJ1536GGMS3JS` and
>   `01M1JPTX00FZNR1GNRXNXMS594` with the `project_data.alarm.completed` log, to confirm no-op ticks
>   now have a bounded cadence and record which fix was the cause. Close if confirmed; write a new
>   fix only if a loop is still seen.

## Problem and evidence

Read-only `sam-api-staging` tail during compact archive verification on 2026-09-08 recorded 426 `project_data.storage_alarm.completed` events for project `01KY2QCEC2FEFDJ1536GGMS3JS` and 409 for `01M1JPTX00FZNR1GNRXNXMS594` between 10:40:00 and 10:41:00 UTC. Sample events reported duration0, measured=false, and null cleanup results. Other projects emitted roughly one event during this minute.

These are separate projects from the archive canary. No causal connection to the canary's two transient R2 deadline errors is established. The storage-alarm implementation is unchanged by PR2034. No alarm state or production settings were modified during this observation.

## Investigation checklist

- [ ] Reproduce with bounded production/staging evidence and identify the effective next-alarm inputs.
- [ ] Inspect `apps/api/src/durable-objects/project-data/storage-alarm.ts`, `computeProjectDataAlarmTime`, and persisted due timestamps for these projects.
- [ ] Determine whether a past-due no-op task is repeatedly scheduled without advancing its deadline.
- [ ] Measure actual request/SQL costs before proposing a fix; do not infer billing from log counts alone.
- [ ] Add a real alarm-cycle regression if a scheduling defect is confirmed.

## Acceptance criteria

No-op alarms have a bounded cadence, while due cleanup and other project work still execute. Document the confirmed cause and measured cost impact.

## Related work (2026-09-25)

The ProjectData alarm now runs only the sections that are due and logs every tick as
`project_data.alarm.completed` with the sections it ran, skipped, or failed and their rows read
(`apps/api/src/durable-objects/project-data/alarm-sections.ts`, task
`2026-09-25-projectdata-root-overload.md`). Storage safety therefore no longer runs on ticks another
section drove, and the section driving any remaining high-frequency ticks is named in that log. Not
verified against these staging projects; re-check with the new log before closing this item.
