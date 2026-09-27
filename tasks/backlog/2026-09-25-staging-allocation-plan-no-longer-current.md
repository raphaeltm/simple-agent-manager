# New tasks fail with "Node allocation plan is no longer current" after a slow node boot

## Problem

On staging, two consecutive conversation-task submissions failed within seconds with
`Node allocation plan is no longer current` (`apps/api/src/services/node-allocation-validation.ts`,
the allocation-plan currency check), each leaving a node row in `error`
(`[hetzner] Node allocation plan is no longer current`). Both followed a node whose VM agent first
heartbeated 15 min 26 s after creation — just past the task's 900000 ms `node_agent_ready` limit —
while that task failed and released it. Production shows no occurrence in the last 7 days.

## Context

Found while verifying failed-task preservation on staging (branch
`sam/preserve-failed-tasks-work-fn8ba7`, 2026-09-25): tasks `01M3CEDPC4SD78CWBDQFJAPZYB`
(14:09:57) and `01M3CEF2X3GKJ44VSJ6YCZV7HK` (14:10:44); error nodes
`01M3CEE47VENM7RTFHD0CGMX7X`, `01M3CEFE66PJD8E73718PFB2WQ`; the late node
`01M3CDGP4KXNXVP01QJMNVEZEY` (created 13:54:12). The branch does not touch placement or
allocation code.

## Acceptance Criteria

- [ ] Identify which input to the allocation plan changed between planning and validation.
- [ ] A plan invalidated by a concurrent, unrelated node transition is re-planned instead of failing
      the task, with the staleness reason recorded in the placement explanation.
- [ ] A regression test reproduces a node reaching readiness (or failing) between planning and
      reservation.
