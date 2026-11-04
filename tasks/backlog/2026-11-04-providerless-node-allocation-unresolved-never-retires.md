# A Node Whose Allocation Never Resolved Is Never Retired

## Problem

Staging node `01M6J4ZSE7XJEZGMXXEWJ8CYDJ` (created 2026-11-04 02:07 UTC) never received a provider
instance. Direct provisioning ended with:

> Allocation unresolved; operator recovery required: Allocation inventory has no exact match; a
> second create is forbidden

The node moved to `destroying`. Every cleanup sweep since then fails with:

> Failed to destroy stale destroying handoff node: Cannot reconcile providerless VM
> 01M6J4ZSE7XJEZGMXXEWJ8CYDJ: allocation remains unresolved despite empty inventory

Cleanup backs off for an hour each time. Nothing retires the node.

- Its workspace `01M6J4ZSW767BF322X7Y0NDAJG` stays in `stopping`: "Runtime deletion unconfirmed after
  attempt 1 (node assignment unavailable)".
- `DELETE /api/nodes/:id` returns 409: "Node runtime termination is not confirmed".

Refusing a second create is correct; the gap is what happens afterwards. The provider inventory
is empty, so no VM exists to bill. Even so, the safety fence holds the rows forever, with no
time bound and no escalation beyond an hourly error row. This is the class Raphaël asked to
eliminate in 2026-10 (InfrastructureLifecycle knowledge): every fence that blocks automatic
cleanup needs a time bound and an escalation path.

## Context

Found during staging verification of lifecycle latency monitoring
(`tasks/archive/2026-11-04-lifecycle-latency-monitoring.md`). The new watchdog alerted the
workspace's `stopping` state at 03:16 UTC as designed.

Around the same time Hetzner returned `403 shared core limit exceeded` for a new staging VM. The
account, shared with production, was at its vCPU quota, which may explain the unconfirmed
create.

## Acceptance Criteria

- [ ] An unresolved allocation whose inventory stays empty across a bounded number of checks
      (configurable), past a configurable age, is retired as `runtime_terminated` with a recorded
      proof reason, and its workspaces finish deletion.
- [ ] An inventory that shows a matching server keeps the current fence (no regression).
- [ ] An alert fires when the bound is reached, naming the node and the provider.
- [ ] Test through the real cleanup sweep with a fake provider inventory: empty, then matching.
