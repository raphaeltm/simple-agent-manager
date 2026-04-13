# Compute Usage Node Overlap Post-Mortem

## What broke

Compute usage totals, quota checks, and admin usage summaries over-counted platform compute whenever a user ran multiple workspaces on the same node at the same time. The API stored one metering row per workspace session and summed every row independently, so a shared node could be billed two or more times for the same wall-clock interval.

## Root cause

The bug was introduced in the initial compute metering implementation on 2026-04-11 in commit `587f1502a9bc259e1a547cef6e50a68daf8a3698` (`feat: admin-level platform credentials, compute metering & quotas (#672)`). The service correctly recorded both `workspaceId` and `nodeId`, but the aggregation code in [compute-usage.ts](/workspaces/simple-agent-manager/apps/api/src/services/compute-usage.ts:95) treated each row as an independent billable session and multiplied `duration * vcpuCount` per workspace row. Node reuse already existed in [node-selector.ts](/workspaces/simple-agent-manager/apps/api/src/services/node-selector.ts:77), so the billing entity and the stored event entity diverged.

## Timeline

- 2026-04-11: Compute usage metering shipped with workspace-scoped aggregation.
- 2026-04-13: Review of compute accounting noticed that real cloud cost follows nodes, not workspace count, when workspaces share a node.
- 2026-04-13: Aggregation was corrected to merge overlapping usage intervals per `nodeId` before converting runtime to vCPU-hours.

## Why it wasn't caught

- The original implementation validated the presence of metering hooks and the arithmetic for isolated sessions, but it did not test overlap behavior on reused nodes.
- The existing unit tests modeled usage as a flat list of sessions without `nodeId`, which made the incorrect billing entity invisible.
- The integration coverage around compute usage was mostly source-contract verification, so CI never exercised the invariant that shared-node time must be counted once.

## Class of bug

This is a shared-resource accounting bug: event rows were recorded at a finer granularity than the billable unit, and the aggregation layer failed to reconcile the difference. The same class can affect billing, quotas, rate limiting, or analytics whenever multiple logical sessions share one physical resource.

## Process fix

The process fix is to require an explicit "billing entity" check during preflight for usage, quota, and cost changes. If events are stored below the billable unit, tests must prove that overlapping records on a shared resource are merged correctly instead of summed blindly.
