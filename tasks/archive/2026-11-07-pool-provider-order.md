# Pool provider order: store it and rank new VMs by it

PR 3a of the provider-priority work (idea `01M6NXTF2RQ5QXHM7YZ4ZF0XBK`). Raphaël wants GCP first
with Hetzner as fallback, via an ordered provider list on the pool. PR 3b adds the fallback across
providers; PR 3c adds the reorder UI.

## Problem

A pool's sources (credentials) had no order. Candidate `priority` restarts at 0 for each source, so
a mixed GCP + Hetzner pool interleaved them by strategy and price; there was no way to prefer one.

## Research findings (plan verified against code; idea note 2026-11-07)

- Order lives on the pool row: `capacity_sources` rows belong to a scope, not a pool.
- Reuse authority requires a node's recorded pool revision to match
  (`placement-authority.ts:167,219`), so a reorder must NOT bump `capacity_pools.revision`, or every
  running node would stop being reusable and new VMs would be created (breaks reuse-first).
- The reconcile CAS guards on `updated_at`, so a rank-only edit must not touch it either.
- `selectionWeights.priority` is an operator-wide setting and unused; do not overload it.
- Reuse ranking (`node-selection.ts`) is unchanged: reuse-first is Raphaël's decision (D1 = b).
- `placement-resolver-capacity.ts` (723) and `default-capacity-pool-updates.ts` (606) exceed rule 18
  and are split first.
- A project/profile `defaultProvider` hard-pins the provider (`placement-resolver-capacity.ts`
  normalize). Whether it should become a preference is an open question to Raphaël; 3a documents
  today's behaviour.
- Deferred to PR 3b: crossing providers on exhaustion. Deferred to PR 3c: UI.

## Implementation checklist

- [x] Split `placement-resolver-capacity.ts` (snapshot + reuse modules) — no behaviour change
- [x] Split `default-capacity-pool-updates.ts` (candidate resolution module) — no behaviour change
- [x] Migration `0226_capacity_pool_source_order.sql` (additive, NULL = no order) + schema column
- [x] Shared types: `CapacityPool.sourceOrder`, `DefaultCapacityPoolUpdateRequest.sourceOrder`,
      `MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH`
- [x] Read: `parseCapacityPoolSourceOrder` (malformed → null + warning)
- [x] Write: request parsing (array/null, ≤32, no duplicates, non-empty); membership check against
      sources serving the pool in its scope; rank-only edit fenced on revision without bumping it;
      combined edit stores it in the same atomic publication
- [x] Ranking: `sourceRank` first key in `compareCapacityCandidates`, `rankCapacityCandidatesForRuntime`
      and `preferCapacityCandidatesInLocation`; unranked ties keep today's order
- [x] Boundary scanner allowlist follows the moved reuse function
- [x] Tests (real SQLite): rank flips the first candidate vs an unranked control; reorder keeps revision
      and selection digest; clear with null/[]; another user's and unknown sources rejected with an
      owner-path control; combined edit bumps once; malformed stored order reads as none. Unit: rank in
      runtime re-ranking ahead of spread; previous-region preference stays inside the top rank; request
      parsing
- [x] Surgical reverts: removing the rank key reddens the ranking tests; bumping the revision on a
      reorder reddens the revision test
- [x] Docs: compute-pools.md "Provider order"

## Acceptance criteria

- [x] A pool can store an ordered list of its sources; no order = today's behaviour
- [x] New-VM candidates from a more preferred source rank first
- [x] Reordering never makes a running node non-reusable
- [x] Only sources serving the pool, in its scope, can be ordered

## Staging

Waived by Raphaël for the provider-priority work (session `eecddba8`, 2026-11-07).

## Review fixes (2026-11-07)

- [x] HIGH (test-engineer, cloudflare-specialist): two concurrent reorder-only edits both passed the
      revision fence, so the later one silently replaced the earlier. The reorder now also fences on
      the stored order value it read (`source_order_json IS ?`); an edit that rewrites the order
      together with policy/candidates carries the same guard in the shared batch fence, so a refused
      guard cannot leave candidate rows updated. Race tests for both paths; each goes red with its
      guard removed.
- [x] Route-level PATCH tests for `sourceOrder` (user, plus installation with a cross-scope source).
- [x] Reuse-after-reorder test through the real writer and `filterReusableNodesByCurrentAuthority`,
      with a revision-bump control.
- [x] Deleted-only source counts as not serving the pool; legacy candidate without `sourceRank`
      ranks as unranked.
- [x] `sourceRank` recorded in `placement_explanation_json` (not part of the authority predicate).
- [x] Service-level cap of 32 ids (bind budget), type-only circular import removed.
- Rule 60: worst-case combined PATCH (candidates + catalogAdditions + policy + sourceOrder) is ~13
  D1 round trips, one over the mutation guide; the order membership read only runs when the order
  actually changes. Accepted for a low-traffic admin route; stated in the PR.
