# Credential re-save must not break compute pools or node cleanup

SAM task `01M7BNEQ5MYA2NCG54EFHHMT7P`, idea `01M76T4XXVQS1TX8VQM2BRPWFG`, branch
`sam/cloud-credential-re-save-hhmt7p`. Sibling fix: PR #2715 (strict teardown with the owner's
current credential).

## Problem

After a user re-saved their GCP connection on staging (2026-11-12 02:19Z and again 2026-11-13
20:55Z):

1. Nodes placed before the re-save were refused by the cleanup cron with
   `cleanup_blocked_reason = provenance`.
2. GCP became unplaceable for that user: every GCP option in their default pool was disabled.

Raphaël's direction: a credential change must not matter to SAM. Rotating a key must not stop
placement or leave nodes running.

## Root cause (verified)

- `replaceUserGcpCredential()` (`apps/api/src/services/gcp-credential-store.ts`) DELETEs the
  user's GCP `credentials` row and INSERTs one with a new ULID on every save. Every other
  provider's user and project save updates the row in place (`routes/credentials.ts`,
  `routes/projects/credentials.ts`).
- `capacity_sources.credential_id REFERENCES credentials(id) ON DELETE CASCADE` (migration 0125),
  `capacity_pool_candidates.capacity_source_id ... ON DELETE CASCADE`, and
  `nodes/workspaces/tasks.capacity_source_id ... ON DELETE SET NULL`.
- So a GCP re-save deletes the user's default GCP source, all of its pool candidates (with the
  user's selections), and nulls `capacity_source_id` on every node, workspace and task placed
  from it.
- The replacement source's candidates start `disabled` by design
  (`initialStatusForProviderOffering`: a newly connected account joins no pool on its own). That,
  not the stale `source_order_json`, is why GCP was unplaceable. Placement only ranks by
  `sourceOrder` (`placement-resolver-capacity.ts`), and the editor filters unknown ids.
- `cleanupNodeProvenanceSql()` and `hasManagedVmPlacementProof()` require a non-empty
  `capacity_source_id`, so every node with a released column is refused forever.

Staging evidence (read-only D1, 2026-11-14 00:01Z): all 6 GCP node rows have
`capacity_source_id` NULL while `capacity_pool_candidate_id` still names
`cap-source-default:user:01M73FZ...`, whose candidate rows no longer exist. Hetzner rows (94)
all keep their source. Smoke pool: 3418 GCP candidates of the new source, all `disabled`;
`source_order_json` still names the deleted source.

Production (read-only, 2026-11-14 00:02Z): 0 nodes, workspaces or tasks in the released shape; 0
pools with dangling order/excluded ids; 1 user GCP credential and 3 running GCP nodes, which a
re-save today would strand.

## Writers that can delete a capacity source (rule 44)

| Writer | Today | After |
| --- | --- | --- |
| `replaceUserGcpCredential` (PUT /api/gcp/service-account, POST /api/gcp/setup, POST /api/credentials gcp) | delete + insert, new id | update in place, id stable |
| POST /api/credentials (non-GCP) | update in place | unchanged |
| POST /api/projects/:id/cloud-credentials (all providers, GCP included) | update in place | unchanged |
| DELETE /api/credentials/:provider, `deleteUserGcpCredential` | deletes row (cascade) | unchanged (disconnect) |
| DELETE /api/projects/:id/cloud-credentials/:provider | deletes row (cascade) | unchanged (disconnect) |
| POST + DELETE /api/admin/platform-credentials | no in-place secret update; rotation is add + delete | unchanged; product question |
| `scrubCapacitySourceCredentialSecrets` | deletes only unreferenced anchors | unchanged |

## Readers of capacity_source_id (rule 63)

| Reader | Purpose | Released value should |
| --- | --- | --- |
| `cleanupNodeProvenanceSql` (cron claim, refusal diagnosis, stopped/destroying phase, warm handoff, empty-node warm handoff) | proof SAM placed the node | admit, when the candidate the node names is gone too (the cascade's own signature) |
| `hasManagedVmPlacementProof` (strict deletion: providerless reconcile, existing termination proof) | same proof | same, with the release checked in D1 by the caller |
| `exactNodeIncarnationPredicate`, `node-rejection-proof` | CAS fence on the current value | unchanged (`IS` compares NULL correctly) |
| `placement-authority`, `node-allocation-validation`, `deployment-node-admission`, `warm-node-claim`, `node-selection`, `scheduler-core` reuse | authority to place new work on the node | refuse (the source that authorized it is gone); unchanged |
| `buildLegacyUnpooledAuthorityPredicate` | legacy unpooled nodes | unchanged: also requires candidate id NULL, so a released node is not "legacy" |
| `workspace-reserved-allocation` (tasks, workspaces) | reuse a reserved allocation | refuse; unchanged |
| task-runner `node-provisioning-recovery`, `node-steps` | in-flight placement reads | unchanged |

## Implementation checklist

- [x] `replaceUserGcpCredential`: keep the user's GCP `credentials` row id stable (UPDATE in
      place, INSERT only when absent, one atomic batch, duplicates collapsed onto the oldest row);
      managed cc mirror rows keep their current replace behaviour and point at the stable id.
- [x] `routes/gcp.ts`: PUT /service-account and POST /setup reconcile capacity pools after the
      save (they never did), so the source's credential version follows the new secret.
- [x] `node-teardown-provenance.ts`: accept a released `capacity_source_id` when the node's
      `capacity_pool_candidate_id` names a candidate that no longer exists; every other snapshot
      field still required. Export the released-source SQL and an async check.
- [x] `hasManagedVmPlacementProof(node, capacitySourceReleased)`; strict-deletion callers compute
      the release from D1.
- [x] Docs: architecture/security or capacity docs that describe provenance and credential
      re-save.
- [ ] Rebase on PR #2715 once merged.

## Tests

- [x] Real SQL engine, full migration chain, FKs on: place a node from the user's default GCP
      source, re-save through the real route, assert the node keeps `capacity_source_id`, the
      cron claim admits it, the pool's candidate selections and order survive, and placement
      still resolves the connection. Must fail on main.
- [x] Project-scoped source (in-place writer) and platform-scoped source (delete, the only
      rotation path) through the real cleanup claim; one non-GCP replace path.
- [x] Damaged rows: node seeded in production's released shape is claimed; pool whose order names
      a missing source still places on its active options.
- [x] Attack controls, each proven discriminating: node with capacity_source_id NULL whose
      candidate still exists is refused; node missing another snapshot field is refused; another
      user's node is not claimed; running node not admitted without opt-in.
- [x] Drive the real cron, warm handoff and placement entry points.

## Acceptance criteria

- [ ] A same-owner GCP re-save keeps the credential id, the default source, its candidates and the
      pool order.
- [ ] A node placed before any source deletion stays claimable by the cron and the warm handoff.
- [ ] No weaker ownership proof: every server-written snapshot field is still required.
- [ ] Staging: re-save the smoke user's GCP connection through the product, place a GCP node with
      no pool edit, stop it, the cron reaps it; GCP side checked with the read-only identity.

## Discrimination evidence (tests/workers/credential-resave-capacity-provenance.test.ts)

| Reverted | Went red |
| --- | --- |
| `replaceUserGcpCredential` back to main (delete + insert) | both GCP re-save tests (id changed; `capacity_source_id` NULL through the real FK) |
| release branch in `cleanupNodeProvenanceSql` | project disconnect (cron records `provenance`), platform rotation (handoff `no_teardown_provenance`), damaged-row claim |
| candidate-absent conjunct of `capacitySourceReleasedSql` | damaged-row test, line asserting the still-listed candidate is refused |
| `placement_credential_fingerprint` in the required list | damaged-row test, missing-fingerprint line |
| running-status opt-in | damaged-row test, running-without-opt-in line |
| `user_id = ?` in `claimNodeForCleanup` | damaged-row test, other-user line |
| release check in the strict-deletion caller | strict deletion twin test |

## Left for Raphaël

- Disconnect-then-reconnect and platform credential rotation (add + delete) still delete the
  source and its selections. Options: in-place secret rotation for platform credentials, keep
  sources and choices across a disconnect, or accept re-picking.
- The staging smoke pool's GCP selections were destroyed by the 2026-11-12 cascade and cannot be
  rebuilt from stored data; GCP there needs options picked once.

## Notes

- Task file kept on the branch rather than pushed to main.
