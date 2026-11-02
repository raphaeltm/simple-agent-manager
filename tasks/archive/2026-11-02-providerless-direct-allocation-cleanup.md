# Recover providerless direct allocation records

## Problem and evidence

The MPTCP staging fixture node `01M6E3RWYZB1GC5R2W7MJ0Q6J5` reached destroying without a provider instance ID. Its complete placement/credential snapshot remains, but its direct conversation task has no auto_provisioned_node_id. Inventory recovery exhausted 29 attempts with no exact match. Automatic cleanup refuses provenance because it requires a provider ID or termination proof before calling the strict inventory path that could establish that proof. User confirms no VMs exist in the staging Hetzner account.

The initial creation interruption is not proven; this fix must not claim to repair an unknown cause or retry ambiguous paid creation. Separate from VM-agent-only PR #2493.

## Plan

- [x] Reproduce through the real cleanup sweep with a complete direct-creation snapshot and no task link.
- [x] Admit destroying providerless nodes with complete ownership snapshots to strict inventory reconciliation.
- [x] Preserve a provisioning grace window before absence proof; retain exact credential/incarnation/provider ownership checks.
- [x] Verify empty inventory converges, uncertain/foreign inventory remains blocked, and repeat sweeps do no work after completion.
- [x] Local checks and independent security/completion review.
- [x] Coordinate staging; verify only owned fixture cleanup, preserve all others.
- [ ] PR, CI, CodeRabbit, merge, production smoke under /do.

## Load and risk

Only fully attributed managed workspace nodes already destroying enter the existing bounded sweep. Existing page limits, per-request/sweep budgets and backoff remain. No new cron, API, provider create, credential fallback or direct database cleanup.

## Validation evidence

Both new regression scenarios failed on the old code. After the fix, 85 cleanup/handoff/stranded-retirement tests pass; API typecheck and scoped lint pass. Independent Cloudflare/security/task-completion review PASS after tightening no-proof admission to require runtime incarnation. Existing proof-bearing behavior preserved.

Normal staging DELETE of our mature node and then workspace succeeded at16:36:10UTC on the peer orphan-repair candidate (not this fix): node HTTP200; workspace HTTP200 deletionStatus confirmed. This is cleanup evidence, not live proof of the new automatic selector. No VM was provisioned, and no other resources were touched.

Staging deployment41483330085 succeeded for implementation0d64d3847. Authenticated Playwright dashboard/projects/settings navigation returned no page errors; health/login/nodes API200, former own fixture GET404. One controlled fresh direct cx23 node01M6EK6ESWN0AERFTBR3W6RKT2 created16:59:02 and normally allocated; DELETE200 at16:59:16 confirmed cleanup. This validates existing allocation/deletion behavior; the failed-allocation edge was not recreated live and is covered by the discriminating real-sweep regression suite. No heartbeat is claimed (not required for these API-only changes). PR/CI/release gates remain pending in workflow state.
