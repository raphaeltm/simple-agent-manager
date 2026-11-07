# Cross-provider fallback by pool provider order

PR 3b of the provider-priority work (idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`). Stacked on PR 3a
(`sam/pool-provider-order`, #2571), and needs PR 2b (#2572) for the selection compaction; rebase
onto main once both merge.

Raphaël: when the preferred provider (GCP) cannot allocate, fall back to the next one (Hetzner).
Decided with him: an existing machine with room is reused first, regardless of rank (already true:
reuse runs before the attempt chain).

## Problem

`buildProvisioningExhaustionPlan` (`node-provisioning-exhaustion.ts`) drops every alternative with
a different `capacitySourceId` ("candidate resolves to a different capacity source credential").
The VM admission lease, the provider cooldown and the compute-quota gate are all resolved once,
from the first candidate, so the chain can never leave one credential domain.

## Research findings

- `tryAcquireVmProvisioningLease` (`vm-admission-control.ts`) upserts ONE `vm_task_admissions`
  row per task (re-pointed to the new scope on each call). A provider cooldown on the domain
  returns `waiting` with reason `provider_account_capacity`; a busy lease returns `waiting` with
  `compatible_node_provisioning`; the wait deadline is per task.
- The lease scope is `user:<id>:workspace-vm:<provider>:<credential domain>`, so switching source
  usually switches scope. On re-entry after a crash, `state.admissionScopeKey` may name the old
  tier's lease; the step must release it when the new identity's scope differs.
- `enforceComputeQuota` reads `state.config.cloudProvider` / credential attribution, i.e. the
  current target. It must run again for each new tier.
- `handleProvisioningAttemptFailure` records cooldowns and success on one `admissionIdentity`.
  Cooldown/success must use the tier being attempted; an end-of-chain `queue` wait uses the
  primary (most preferred) tier's identity.
- Core-quota rejections are Hetzner account facts; they must only rule out attempts of the same
  capacity source.
- Fallback triggers (rule 72): `transient_capacity`, a Hetzner account limit, and any provider's
  `quota_exceeded` (the create was refused; no VM exists). Never `unknown`, timeouts, auth or
  invalid config: those can leave a ghost VM or signal a broken credential.
- `compactCapacityPoolSelectionForTaskRunner` (`services/task-runner-do.ts`, after PR 2b) keeps the
  longest ranked prefix within 96 KiB. Rank sorts GCP first, and a live GCP catalog alone exceeds
  the budget, so every lower-rank candidate is dropped. It must keep each source's best candidates.
- `PlacementAttemptDiagnostic.outcome` is a shared enum; do not add a value (rule 79). Use
  `not-attempted` with a reason, as the core-quota skip does.

## Decisions (defaults; Raphaël may revisit)

1. Tiers follow the pool's provider order. Without an order nothing changes (no cross-source).
2. Within one rank value only the first source is used; same-rank sources do not fall back to each
   other. Unranked sources form the last rank when the pool has an order.
3. `fallback-chain` tries every offering of a tier; `fail` and `queue` try the first offering of
   each tier. `queue` waits (on the primary tier) only after every tier is exhausted.
4. A project or profile `defaultProvider` stays a hard pin (unchanged).
5. A tier whose provider is cooling down, whose credential cannot be resolved, or whose compute
   quota is exhausted is skipped with a reason. A tier whose lease is held by another task parks
   the task as today (`compatible_node_provisioning`); the wake restarts from the primary tier,
   where reuse-first can pick up the other task's node.

## Implementation checklist

- [x] Exhaustion plan in tiers (`tierKey`, `sourceRank` on each attempt); tier membership and
      same-rank exclusion with diagnostics
- [x] Step loop: index-based; tier switch releases the old lease, re-targets, rebuilds identity,
      re-runs compute quota, acquires the new lease; skip reasons recorded per attempt
- [x] Failure handler: returns the next index; account limit or `quota_exceeded` with a later tier
      moves to that tier (cooldown recorded on the failing domain); core-quota rejections scoped by
      capacity source; primary vs attempt identity
- [x] Re-entry: release a stale lease from another scope before acquiring
- [x] Terminal message names providers when the plan spans more than one
- [ ] Compaction keeps each source's best candidates (after rebase onto PR 2b)
- [x] Docs: compute-pools.md "Provider order" (fallback behaviour)
- [x] Tests (below)
- [x] Review fixes (2026-11-07, second session): the first tier is skipped like later tiers when
      a later tier exists (cooldown, spent quota, missing credential); compute quota is charged to
      the tier being attempted, not `candidates[0]`; `fallback-chain` attempts per tier capped by
      `operations.provisioningAttemptsPerProviderTier` (default 8)

## Tests

- GCP stockout → Hetzner tier succeeds; lease switched; success recorded on Hetzner identity
- GCP `quota_exceeded` → next tier; Hetzner account limit with a later tier → next tier + cooldown
- `unknown` / auth / timeout on tier 1 → fail fast, no tier 2 attempt (control)
- No order → no cross-source attempt (control, today's behaviour)
- Same-rank second source excluded
- `fail` policy: one attempt per tier; `queue`: waits on the primary identity after all tiers
- Tier 2 in cooldown → skipped; tier 2 lease busy → waits
- Core-quota rejection on source A does not skip source B's offering
- Re-entry with a stale lease on another scope releases it
- Compaction keeps a lower-rank source when the first source alone exceeds the budget
- Each guard proven by surgical revert

## Worst case per step (rule 81 / rule 47)

Attempts in one `node_provisioning` step: at most `tiers × operations.provisioningAttemptsPerProviderTier`
under `fallback-chain` (default 8), or one per tier under `fail`/`queue`. Tiers are bounded by
the distinct ranks in the pool's provider order (one per supported provider in practice). Each
attempt is about a dozen subrequests (node row, task fence, lease mark, provider create and
operation polls, failure bookkeeping); each tier switch adds lease release, identity, quota and
lease acquire (about five). A three-provider order is therefore at most 24 creates and roughly
300 subrequests, under the Worker per-invocation limit. Before the cap, a live GCP catalog
(hundreds of zone × type offerings) could exceed it on one tier.

## Staging

Waived by Raphaël for this work (session `eecddba8`, 2026-11-07).

## Progress notes

- 14 tests in `tests/unit/durable-objects/task-runner-provider-tiers.test.ts`. Surgical reverts:
  no new tiers → 10 red; same-rank allowed → same-rank test; `fail` tries all → fail test;
  no refused-tier move → quota, account-limit and core-quota tests; unscoped core quota →
  core-quota test; no stale release → restart test; queue on current tier → queue test; no
  cooldown skip → cooldown test; no missing-credential skip → credential test; success recorded
  on primary → first test.
- Step split for rule 18: `node-provisioning-lease.ts` (primary lease), `node-provisioning-tier.ts`.
- Second session reviews: architecture HIGH, CF CRITICAL and test-engineer CRITICAL were the same
  defect (tier 0 gates could not skip). Fixed via `enterPrimaryProvisioningTier`. Found while
  fixing: `resolveCapacityAwareQuotaCredentialSource` read `candidates[0]`, so a user-credential
  later tier below a platform tier was charged to the platform quota. Fixed with a
  `targetCandidate` parameter. Test-engineer HIGH (GCP quota writes no cooldown) is intended: a
  GCP quota is regional, and a domain cooldown would block other regions; documented in code and
  docs. 9 new tests; surgical reverts: cooldown skip, quota skip, credential skip, target
  candidate, later-tier quota and the per-tier cap each redden exactly their test.
