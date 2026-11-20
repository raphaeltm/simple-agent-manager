# Never-requested node rows loop in cleanup; max-lifetime ignores its backoff

SAM task `01M7W36KNP2QKSF4R1MR6T75X3`; idea `01M7GVRC956Q8JMGCRP1PQ4R5B`. Approved by Raphaël
2026-11-20.

## Problem

Production nodes `01M7FCGMP496H9ZY2FXC3W326T` and `01M7FCGDQFAZDKY9EXKAF6PQJ4` (GCP, 2026-11-15)
failed provisioning with "Node allocation plan is no longer current" before any provider create.
Every cleanup sweep since then fails with "Failed to destroy max-lifetime node: Providerless VM
termination proof lacks managed placement" (436 of 700 sampled API errors in the week). Each
failure records `backoffUntil = now + 1h`, but the nodes are retried every 5-10 minutes.
`01M7GQ1N72RQZ6VK7QK421QB5Z` (same cause, `destroying`, no task link) is refused for `provenance`
by the stranded sweep every 5 minutes.

## Research findings

- Production D1 (read-only, 2026-11-20 09:14Z): all three rows have
  `runtime_termination_confirmed_at = created_at`, `transport IS NULL`, no provider instance ID,
  no `placement_credential_fingerprint`, no attestation, no pending deletion. The two error rows
  are task-linked; the destroying row is not. Backoff of all three: `updated_at + 5 min`.
- `createNodeRecord` (`services/nodes.ts`) inserts every VM row with proof = `created_at`. The
  provider identity claim in `provisionNode` (`services/node-provisioning.ts`) is the only path to
  a create; it clears that proof, rotates the incarnation and stamps `transport` in one CAS write.
  The resume path requires proof NULL. Later proof writers stamp later times. So proof =
  `created_at` with `transport` NULL is positive proof no create was sent.
  `cleanupFreshProvisioningNode` already deletes such a placeholder on the proof alone.
- The gate in `deleteNodeResourcesStrict` (#2157) requires `hasManagedVmPlacementProof` for any
  providerless `destroying` proof, which needs the fingerprint the pre-create failure never wrote.
- Backoff defect: `handleCleanupFailure` → `recordCleanupRefusal` rewrites the backoff to
  `min(failureBackoff, refusalWarnAfterMs = 5 min, deadline)`, so every failure retried in ~5 min.
  For `stopped`/`destroying` rows past the stranded deadline the same code wrote a zero backoff.
- Uncertain providerless `error` rows (create may have been sent) were released back to `error`,
  which wipes the blocked reason, hides them from `node_destroying_too_long`, and leaves them to the
  max-lifetime sweep. GCP's reconcile refusal was a plain error.

## Checklist

- [x] Named state `neverRequestedVmPlaceholderSql` / `isNeverRequestedVmPlaceholder`
      (`services/node-never-requested-placeholder.ts`)
- [x] Strict deletion accepts the insert-time proof for that state
- [x] `cleanupNodeProvenanceSql` admits the state (non-running statuses only); max-lifetime selector
      admits it without a task link
- [x] Failed attempts keep their failure backoff (`failureRetryAt`), capped only by a stranded
      deadline that is still ahead
- [x] Uncertain providerless `error` rows are parked in `destroying` on failure
- [x] Non-Hetzner providerless reconcile refusal named `teardown_allocation_unresolved`
- [x] Tests through `runNodeCleanupSweep` on real SQLite: retire x3 shapes, may-have-created
      controls x4, GCP refusal, two-sweep backoff zombie; each guard proven discriminating
- [x] Docs: admin-settings (stuck nodes), configuration (`NODE_CLEANUP_FAILURE_BACKOFF_MS`)
- [ ] Staging verification
- [ ] After production deploy: the three rows reach `deleted` via the sweep; the
      "lacks managed placement" errors stop (`ops_search_errors`)

## Acceptance criteria

- A never-requested row retires without a provider call; a may-have-been-created row is never
  retired without proof.
- Unclassifiable rows reach an operator-visible state (blocked reason, anomaly) on a bounded cadence.
- A failing candidate is not re-attempted before its recorded backoff (two-sweep test).
- Each guard proven discriminating.
