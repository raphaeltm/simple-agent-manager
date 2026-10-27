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
- [x] Change shared default to 80 and synchronize configuration documentation.
- [x] Enumerate admission/reuse callers; close deployment empty-host bypass and stopped/error restart/rebuild bypass.
- [ ] Test 79.99 / 80 / above, overrides, missing/stale telemetry, occupied and empty reuse, final SQL and preserved work.
- [x] Document existing retirement and limitations.
- [ ] Run lint, typecheck, tests, build and independent specialist reviews.
- [ ] Deploy and verify staging; create PR, CI and CodeRabbit gates, merge and basic production smoke.

## Acceptance
New admissions use configurable 80% default with equality rejected, across every node placement path. Existing work remains unchanged. Unknown occupied-node telemetry fails closed. Empty initial hosts retain existing compatibility. Staging and review gates pass; retirement limits are explained.

## Retirement findings
`services/node-warm-handoff.ts` and `scheduled/node-cleanup/empty-node-warm-handoff.ts` hand eligible empty managed workspace VMs to NodeLifecycle. Its warm timeout rechecks occupancy/claims before teardown; sweep backstops cover missed handoffs/stale warm state. Disk pressure does not change lifecycle state, evict running work, prune files, or immediately drain a node. Retirement depends on workspaces releasing reservations, retention/claim guards, managed provider provenance and functioning cleanup/provider APIs. User-owned and deployment-role nodes are intentionally outside workspace-node cleanup. Active application deployments remain on their node; admission alone does not relocate or reclaim them.

## Verification notes
Initial tests failed at the requested 80% boundary against the 90% default. Removing the deployment SQL fix independently reproduced two empty-host admission/telemetry failures, then the fix was restored. Existing env/scaling overrides are retained. No new environment variable or cleanup mechanism.


Review discovered stopped/error restart and error rebuild restored inactive reservations without admission. These now use the same atomic admission as evicted restarts; running/recovery rebuild retains its existing reservation. Legacy same-environment deployment re-releases are retained existing work: their adoption path cannot place a new environment or select another host, so it remains unchanged.

Inactive legacy workspaces without a project, valid persisted reservation or current placement authority now fail closed with HTTP 409; existing active work is unchanged.
