# Record absence proof when provisioning fails after the identity claim but before the create

## Problem

PR #2937 retires node rows whose provisioning failed before the provider identity claim. Those rows still
carry the insert-time absence proof (`isNeverRequestedVmPlaceholder`). A failure after the claim and before
`provider.createVM` still leaves a row that cannot be classified: the claim has cleared the proof and stamped
`transport`. The two places this happens are the second `assertNodeAllocationPlanCurrent` call and tunnel
preparation, both in `provisionNode` (`services/node-provisioning.ts`). Provisioning knows no create was sent
(`providerCreateRequested === false`), but it writes nothing that says so. Cleanup therefore parks the row in
`destroying`. On providers other than Hetzner it becomes a `teardown_allocation_unresolved` refusal that needs an
operator, and a direct node in `error` is selected by no sweep at all.

## Context

Found during PR #2937 staging verification on staging2, 2026-11-20. Node `01M7W5MRNRFH5X3C116K3E8RV3`, a direct
GCP node, ended `error` with "Node allocation plan is no longer current". It has proof NULL and transport
`cloudflare-tunnel` (so the claim ran), and no instance ID.

## Acceptance criteria

- [ ] `recordFailedProvisioningNode` (`services/node-provisioning-failure.ts`) writes an absence proof, in the
      same fenced write, when `providerCreateRequested` is false. This applies to non-durable allocations only. A
      durable allocation resumes the same incarnation and requires a NULL proof (`provisionNode` `resuming`), so
      it needs its own design.
- [ ] A durable control: a resumed allocation still sees a NULL proof.
- [ ] A test drives the real `provisionNode` to fail at the second plan check. It asserts the row then retires
      through `runNodeCleanupSweep` with no provider call.
- [ ] A control: a failure after `providerCreateRequested = true` is never given the proof.
