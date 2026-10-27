# 80% disk usage admission threshold

## Problem
A production node at 92% disk has repeated unable-to-write failures. Reject new workloads at or above a configurable 80% default while preserving running work. Parent investigates production independently; no destructive production changes.

## Research
- Shared policy: `workspace-resource-capacity.ts`; configurable through existing `TASK_RUN_NODE_DISK_PRESSURE_THRESHOLD_PERCENT` and scaling override.
- Advisory task selection (occupied and warm), workspace insert/restart/recovery atomic admission and deployment-node selection/final binding must agree.
- Deployment final SQL currently skips telemetry for empty running hosts: close this bypass using existing pressure policy, preserving fresh-node no-telemetry compatibility.
- Missing/stale/malformed telemetry fails closed for occupied nodes. Empty fresh nodes may lack initial metrics; reported bad or stale metrics must not be ignored.
- Investigate existing empty-node warm handoff, lifecycle timeout and deployment-node ownership; document retirement limitations without cleanup additions.

## Checklist
- [ ] Change shared default to 80 and synchronize configuration documentation.
- [ ] Enumerate admission/reuse callers; close uncovered deployment final-write bypass.
- [ ] Test 79.99 / 80 / above, overrides, missing/stale telemetry, occupied and empty reuse, final SQL and preserved work.
- [ ] Document existing retirement and limitations.
- [ ] Run lint, typecheck, tests, build and independent specialist reviews.
- [ ] Deploy and verify staging; create PR, CI and CodeRabbit gates, merge and basic production smoke.

## Acceptance
New admissions use configurable 80% default with equality rejected, across every node placement path. Existing work remains unchanged. Unknown occupied-node telemetry fails closed. Empty initial hosts retain existing compatibility. Staging and review gates pass; retirement limits are explained.
