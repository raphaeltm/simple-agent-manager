# On a GCP regional quota refusal, exhaust GCP before leaving it (slice 2 of "make SAM use GCP first")

SAM task 01M7D36PKX3YHK4CTW8T1F4YV4. Idea 01M77QAMDKN1FSSFKMYJK63X22 (notes 2026-11-14 11:16Z, 12:36Z).

## Problem

`handleProvisioningAttemptFailure` (node-provisioning-failure.ts, step 2) treated any `quota_exceeded`
as "source refused" and jumped to the next provider tier. Production placement explanations show
attempt 1 (gcp europe-west1-b t2d-standard-8) failed with `Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in
region europe-west1.`, attempts 2-8 not-attempted, then Hetzner (tasks cron-1a732cc1…35bf,
01M758A6F8BHWA5VHBB6N6KDYW, 01M79S0WNAMWY7H5C8MDBNRNWH). Unused at the time: europe-west4 T2D (0/24),
E2_CPUS (0/72), smaller T2D types. 14 Hetzner VMs followed such a refusal.

## Decision (made; do not re-ask)

A GCP quota error is scoped to the bucket it names (metric + region). Skip the remaining same-source
offerings in that bucket whose vCPU count is not smaller; keep trying the rest of the tier (smaller
types in the bucket, other regions, other families). Only when the GCP tier is exhausted does the
chain move on. Per-tier attempt list must span buckets.

## Research Findings

- Existing Hetzner core-quota descent (`node-provisioning-core-quota.ts`): rejection list consulted by
  the step loop (`node-provisioning-step.ts`) and the failure handler's `nextEligibleAttemptIndex`.
  Extended in place (renamed `node-provisioning-quota-descent.ts`) rather than a parallel mechanism.
- GCP errors reach the TaskRunner as `quota_exceeded` via `withGcpErrorCategory`; message text is the
  only place the metric and region survive (`providerFetch` keeps `error.status` only).
- Consumers of the changed predicate (`sourceRefused` / quota classification, rule 67):
  1. failure handler step 1 (descend) — now also for a GCP bucket with a same-tier offering left;
  2. step 2 (next tier) — unchanged condition, reached when no same-tier offering is left;
  3. step 3 (domain cooldown/wait) — `classifyVmProviderCapacityError` is Hetzner-only; unchanged;
  4. step 4 (fail fast for unknown/auth/timeout/ambiguous) — unchanged; controls already in
     task-runner-provider-tiers.test.ts ("what never crosses providers");
  5. `vm-admission-provider-capacity.ts` — comment only.
- Per-tier cut `DEFAULT_PROVISIONING_ATTEMPTS_PER_PROVIDER_TIER` (8): under `pack` the 8 best GCP
  offerings were all t2d (ew1 + ew4), so e2 was never in the plan.

## Implementation Checklist

- [x] providers: `classifyGcpQuotaBucket`, `gcpQuotaBucketCovers`, `gcpOfferingQuotaBucketKey`
- [x] api: generalise core-quota rejection to `QuotaRejection` (hetzner-cores | gcp-bucket)
- [x] failure handler: descend on a GCP bucket rejection with a same-tier offering left; reasons name the bucket
- [x] exhaustion plan: cap per tier spread round-robin across quota buckets, ranked order kept
- [x] tests through the real step with errors from the real `GcpProvider.createVM` producer
- [x] docs: compute-pools guide
- [x] cooldown decision recorded (not built; see notes)

## Acceptance Criteria

- [x] T2D_CPUS in ew1 → skip same-or-larger t2d in ew1, try smaller t2d, other regions, other families
- [x] GCP tier exhausted → Hetzner
- [x] Quota naming no region → next provider at once (control)
- [x] Per-tier cap spans buckets (9 exhausted t2d + 1 e2: e2 tried)
- [x] Hetzner core quota behaviour, fail-fast controls unchanged (existing tests green)
- [x] Staging: a GCP quota refusal descends within GCP on the live TaskRunner

## Notes

- Consumers reviewed (rule 67), sixth one: `isProviderCreateRejectedBeforeVmIdentity`
  (`node-provisioning-predicates.ts`) also keys on `quota_exceeded` but is Hetzner-only. Intentionally
  not extended: a GCP quota refusal leaves the node row in `error`, and `discardProviderRejectedNode`
  deletes it (`provider_instance_id IS NULL`), the same path main already took once per task for the
  GCP tier fallback.
- Worst-case added latency before falling back (rule 81): one refused create per attempt, at most
  `operations.provisioningAttemptsPerProviderTier` (default 8) per tier. Each refusal costs the
  firewall ensure, the insert and the operation poll; GCP normally reports a quota refusal on the
  insert operation within seconds, but the poll is bounded by `operationPollTimeoutMs` (5 min), so the
  hard bound is 8 × (insert + poll ≤ 5 min). Typical: tens of seconds.
- Cooldown: not built. Each concurrent task may pay up to the per-tier cap of refusals (smaller types
  in a refused bucket are deliberately retried), instead of one new VM on another provider each. A
  region-and-metric cooldown with a TTL would trim those refusals but needs a shared store and a TTL
  that matches how fast quota frees as nodes are deleted; not worth it at current volume (the
  2026-11-12 10:54-11:07Z burst was 7 tasks).
- Per-tier cap: slots dealt round-robin across region+series buckets, distinct sizes before zone
  repeats within a bucket. With more buckets than slots, later buckets are dropped and each kept bucket
  gets one offering.
- Metrics outside `<SERIES>_CPUS`, `CPUS`, `SSD_TOTAL_GB` count as `other` and rule out their region;
  a metric with no region (`CPUS_ALL_REGIONS`) leaves the source at once (the old behaviour).
- Discrimination: GCP rejection disabled → 6 descent tests red (global-quota control stays green); cap
  reverted to "first 8 by rank" → spread test red; distinct-size ordering removed → zone-duplicate test red.

## Staging Evidence (2026-11-14, staging at c0629d5dd, run 43620525214)

Smoke-user pool temporarily set to `fallback-chain` with only t2d-standard-16 enabled in europe-west1-b,
europe-west1-c and europe-west4-a (reverted afterwards). Staging T2D_CPUS quota is 24 per region.
- Node 01M7DHWJCNVTFFTXG2BZZJF2TP (t2d-standard-16, europe-west1-b) took 16 of europe-west1's 24 T2D vCPUs.
- Task 01M7DJ4D5P4429DX8Q8XZ8TFNC (exclusive, provider gcp, ≥9 vCPU) placement record:
  1. europe-west1-b t2d-standard-16 — `capacity-exhausted`: "GCP quota T2D_CPUS in europe-west1 is used up for
     this offering; trying smaller types of this family, other families and other regions before another
     provider. Provider error: GCP operation failed: QUOTA_EXCEEDED: Quota 'T2D_CPUS' exceeded.  Limit: 24.0 in
     region europe-west1."
  2. europe-west1-c t2d-standard-16 — `not-attempted`: "Skipped: needs 16 vCPU, and GCP quota T2D_CPUS in
     europe-west1 already rejected a 16-vCPU offering"
  3. europe-west4-a t2d-standard-16 — `succeeded` (node 01M7DJ5CG7MJSXPTNCPVMNSRGG).
- Real `provisionNode` + D1 path: no node row left behind for the refused europe-west1 attempt (only the two
  real nodes existed), which answers the validator's MEDIUM about repeated descents.
- Side finding (pre-existing, filed as idea 01M7DJ7TJA6CAWHX3VEBTXCZZN): an exclusive task took another task's
  freshly provisioned node, and the provisioner failed after 3 placement refusals instead of re-provisioning.
- Cleanup: tasks terminal, workspaces deleted, node 01M7DHWJCNVTFFTXG2BZZJF2TP deleted, node 01M7DJ5CG7MJSXPTNCPVMNSRGG
  in `destroying` with its GCP instance already gone (read-only `aggregated/instances` check), pool reverted to
  `queue` (revision 78).
