# Investigate repeated no-op ProjectData storage alarms on staging

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
