# Investigate Orphaned ProjectData Alarm Wall-Time Regression

## Problem Statement

The staging `quality:do-wall-time` gate reports a persistent ProjectData alarm regression for namespace `95fdea1992ac4f6cb80ca133c0500e3c`. On 2026-08-06 the current failing object was `01KP5SJ5XZFZFZCQM8YG` at 3.26x baseline (1,595 ms recent average P99 versus 489 ms baseline, 1,573 recent requests). PR #1750 does not change the ProjectData alarm path, and the same quality script is byte-identical on current `origin/main`.

The object is orphaned from control-plane state: read-only staging D1 queries found no project, node, or workspace row matching either the current object ID or the previously reported object `01KJVGMWX26SGQ5DX94G`. This makes the regression independent of PR #1750, but it remains a real operational issue rather than a passing gate.

## Investigation Checklist

- [ ] Map namespace `95fdea1992ac4f6cb80ca133c0500e3c` to its deployed Durable Object class and confirm the object-name derivation.
- [ ] Query Cloudflare Durable Object alarm/log evidence for both orphan object IDs and identify the repeating alarm work.
- [ ] Determine why alarms continue after the corresponding project/node/workspace records disappear.
- [ ] Add lifecycle cleanup or an alarm self-termination condition for orphaned ProjectData objects.
- [ ] Add regression coverage proving an orphaned object stops rescheduling itself without deleting valid retained project data.
- [ ] Re-run `pnpm quality:do-wall-time` after an observation window and confirm the namespace is below the configured threshold.

## Acceptance Criteria

- [ ] The orphan alarm source and persistence mechanism are explained with production-shaped evidence.
- [ ] Orphaned ProjectData objects stop consuming recurring alarm wall time safely.
- [ ] The wall-time gate passes after the observation window, or any remaining regression is attributed to a live project with a separate task.

## Evidence

- Current-main-compatible run at 2026-08-06 18:56 UTC: `01KP5SJ5XZFZFZCQM8YG`, 3.26x, 1,595 ms recent average P99, 489 ms baseline average P99.
- Prior reported object: `01KJVGMWX26SGQ5DX94G`.
- Staging D1: no matching rows in `projects`, `nodes`, or `workspaces` for either object ID.
- Triggered while completing PR #1750; intentionally not folded into the incident-evidence feature branch.
