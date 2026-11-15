# Provider orphan sweep: follow-ups deferred from P1b review

Found by the security-auditor and cloudflare-specialist reviews of the P1b orphan-sweep fix
(SAM task 01M7FCKQ6B82AM5SYWEDDYK8ZB, branch `sam/task-p1b-prove-platform-dyk8zb`). All are
MEDIUM/LOW, pre-existing or outside that change's scope; none lets a foreign, young or claimed VM
reach a provider delete.

## Problem

1. **Interval marker is last-writer-wins across accounts** (cloudflare MEDIUM, pre-existing).
   `reconcileProviderOrphans` resets `skipped=false` when any user account resolves, and sets
   `skipped=true` when any later account's list fails. `runProviderOrphanReconciliation` stamps the
   hourly marker only when `!result.skipped`. So a failed platform inventory followed by a good
   user account is stamped (platform waits an hour), and a good platform inventory followed by one
   failing user account is not stamped (the platform list and GCP delete requests repeat every
   5 minutes until the credential cursor wraps). The skip reason of the earlier account is lost.
2. **A delete request that never completes has no escape path** (security LOW L1, cloudflare LOW).
   GCP deletions are send-and-return; one GCP accepts and then fails asynchronously (org policy,
   lien) is requested again every pass and spends one of `PROVIDER_ORPHAN_DESTROY_LIMIT`. Five such
   VMs at the front of the stable list order starve later orphans and the user-credential loop
   (rule 47 requirement 3). Likewise candidates that time out repeatedly consume the sweep budget.
3. **Audit record written after the DELETE** (security LOW L3). `recordDestroyedOrphan` runs
   after `requestVMDeletion`; a Worker that dies in between leaves an issued DELETE with no record.
   `VmDeletionRequestOptions.beforeSend` exists for exactly this.
4. **A persistently broken platform credential retries every 5 minutes** (cloudflare LOW).
   `credential-resolution-failed` / `provider-list-failed` are skipped runs, so the marker is never
   stamped; each tick now writes a failed-sweep row and attempts a token exchange.
5. **Borrowed tunables** (cloudflare LOW). The sweep uses `NODE_STOPPED_HANDOFF_SWEEP_BUDGET_MS` and
   `NODE_STOPPED_HANDOFF_REQUEST_TIMEOUT_MS`, shared with the stopped-handoff path.
6. **Re-read still walks zones** (cloudflare/security MEDIUM, partly fixed in P1b). The delete now
   reads only the proven zone, but the ownership re-read (`GcpProvider.getVM`) still walks up to 8
   labelled zones plus an aggregated list. `listVMs` already returns the zone; passing it to the
   re-read would cut that to one GET.

7. **Platform-wide failures that surface per account** (security LOW, round 2; partly fixed in
   P1b after CodeRabbit). A D1 claim-lookup failure now stays in `errors` wherever it happens.
   Still open: a platform-wide GCP token/WIF misconfiguration hits every user GCP account inside
   `resolveInventoryProvider`, which counts each as `accountErrors`, so the sweep reports green
   (nothing is deleted: resolution fails before any provider call). The deletion audit write
   (`recordDestroyedOrphan`, via fail-silent `persistError`) runs AFTER the DELETE or deletion
   request was sent, so its failure can leave a sent delete with no audit row (see item 3).
8. **Account failure logs carry no credential id or provider** (cloudflare LOW, round 2).
   `provider_orphan.list_failed`, `account_inventory_failed` and `destroy_failed` cannot tell
   operators which tenant account fails, and they are now the only signal for it.

## Acceptance criteria

- [ ] Platform-inventory completion is tracked separately from user accounts; the marker is stamped
      when the platform inventory completed, and every account's skip reason is kept. Tests for both
      scenarios above, through `runProviderOrphanReconciliation`.
- [ ] Requested deletions persist their ticket (via `beforeSend`), the next pass reads
      `getVMDeletionStatus`, and a `failed` status backs off or quarantines the candidate; a test
      shows five never-completing requests do not starve a sixth orphan.
- [ ] The deletion audit record is written before the DELETE is sent.
- [ ] A failing platform credential backs off (bounded, configurable) instead of retrying every tick.
- [ ] Dedicated `PROVIDER_ORPHAN_*` timeout/budget tunables (or documented aliases).
- [ ] The ownership re-read uses the listed zone when known.
- [ ] A pass where every attempted account failed (for example a platform-wide WIF
      misconfiguration) raises an error-level signal.
- [ ] Account-scoped failure logs carry the non-secret credential id and provider.
