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
- [ ] Staging: a GCP quota refusal descends within GCP on the live TaskRunner

## Notes

- Worst-case added latency before falling back (rule 81): one refused create per attempt, at most
  `operations.provisioningAttemptsPerProviderTier` (default 8) per tier. A GCP quota refusal comes back
  from the insert operation in seconds, so ≤ 8 × (insert + operation poll) ≈ tens of seconds before
  another provider, against a new VM on another provider today.
- Cooldown: not built. With bucket-scoped skipping each task pays at most one refused create per
  bucket; the 2026-11-12 10:54-11:07Z burst of 7 would cost 7 refusals of a few seconds each instead of
  7 Hetzner VMs. A shared cooldown store would add state that goes stale as nodes are deleted.
- Discrimination: GCP rejection disabled → 6 new tests red (global-quota control stays green); cap
  reverted to "first 8 by rank" → only the spread test red.
