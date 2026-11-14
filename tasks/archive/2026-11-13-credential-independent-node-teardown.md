# Credential-independent node teardown

SAM task `01M7B54TKYBMQY13KKG0D0NJMQ`, idea `01M76T4XXVQS1TX8VQM2BRPWFG`, branch
`sam/node-teardown-work-after-d0njmq`.

## Problem

Strict node teardown resolves only the exact credential row and ciphertext generation a node was
placed with (`requireStrictNodeProvider()` / `resolveStrictNodeProvider()` in
`apps/api/src/services/strict-node-deletion-shared.ts`, via `createProviderForExactCredential()`).
Any rotation, re-save or reconnect of the owner's cloud credential therefore strands every node
alive at that moment: SAM refuses before it ever calls the provider and retries quietly.
`replaceUserGcpCredential()` (`apps/api/src/services/gcp-credential-store.ts`) deletes and
re-inserts the user's GCP credential with fresh IDs on every save, which is how three staging GCP
VMs were stranded on 2026-11-12/13.

Raphaël (2026-11-13): teardown must not depend on which credential created the node; rotating a key
must not leave nodes running.

## Research findings

- Exact resolver: `apps/api/src/services/provider-credential-exact.ts`. Returns null when the row
  is gone or its generation moved. `createProviderForUser()` without an exact binding resolves the
  owner's current credential project -> user -> platform (`provider-credentials.ts`), the same
  order provisioning uses.
- Strict teardown callers of the resolver: `deleteStrictProviderInstance()` (via
  `resolveStrictNodeProvider`) and `reconcileStrictProviderlessVm()` (via
  `requireStrictNodeProvider`), both in `strict-node-deletion.ts`. No other callers of
  `requireStrictNodeProvider` / `resolveStrictNodeProvider`.
- `deleteNodeResourcesStrict()` is the single funnel for every teardown entry point: owner DELETE
  (`node-resource-deletion.ts`), NodeLifecycle stop (`node-resource-lifecycle.ts`), cron
  (`scheduled/node-cleanup/shared.ts` `destroyNodeForCleanup`, used by node-phases, unhealthy
  nodes, stranded retirement), deployment cleanup, provisioning-race cleanup, TaskRunner.
- Ownership-label proof already exists for destructive paths: `buildNodeProviderLabels()`
  (`node-provider-labels.ts`), `hasAmbiguousLabel()` (providers `kv-tags.ts`), and the
  `providerInventoryMatchesLabels()` check in `strict-node-deletion.ts` (providerless reconcile),
  mirrored in `node-allocation-recovery.ts`. Every provider's `getVM` returns labels (Hetzner,
  Scaleway, Vultr, DigitalOcean, UpCloud, GCP, Infomaniak).
- Labels on every SAM VM: managed, node (lowercased id), role, env, installation, incarnation
  (GCP adds sam-managed). Verified on six VMs on 2026-11-13 per the idea notes.
- Cron failure path: `handleCleanupFailure()` re-diagnoses and records `cleanup_blocked_reason`
  via `recordCleanupRefusal()`; the stranded sweep overwrites it with the catch-all
  `strict_provider_ownership_or_deletion_failure` and raises `alertBlockedNode()`. The
  `node_destroying_too_long` anomaly displays `cleanup_blocked_reason`.
- A wrong-account 404 is never absence proof (`deployment-legacy-binding.ts` says so too). With a
  fallback credential, "not found" cannot prove the instance is gone.
- Staging state 2026-11-13 19:16Z: Raphaël deleted the three stranded VMs by hand in GCP
  (19:04-19:05Z) and SAM finalized the nodes via owner-attested proof. They can no longer be the
  live acceptance test; staging verification must reproduce the incident.
- Side observation: every staging GCP node row has `capacity_source_id` NULL, so the cleanup
  provenance snapshot predicate (`cleanupNodeProvenanceSql`) and `hasManagedVmPlacementProof`
  reject them; deployment-role nodes are also outside that predicate by design. That is why two
  of the three nodes showed `provenance`. Out of scope; recorded on the idea.

## Design

1. Keep the pinned exact credential when it resolves (unchanged behaviour, unchanged 404
   handling).
2. When it does not resolve (row gone, generation moved, binding absent), collect the node
   owner's current credentials for the node's provider: provisioning resolution
   (project -> user -> platform, via `createProviderForUser`) for the node's attribution scope,
   then every enabled platform credential for the provider (per-row isolated). Never another
   user's or project's credential. If a resolution threw and nothing resolved, the attempt is an
   ordinary retryable failure, not a "no credential" verdict.
3. With a current credential, re-read the instance immediately before `deleteVM` and require the
   recorded instance ID plus exact, unambiguous labels: managed, node, role, env, installation,
   incarnation. A mismatch preserves the VM and the next credential is tried. A credential that
   cannot see the instance is not absence proof.
4. Failure reasons are typed (`NodeTeardownBlockedError`) and named:
   `teardown_credential_unavailable`, `teardown_instance_not_visible`,
   `teardown_instance_ownership_mismatch`, `teardown_ownership_scope_unavailable`, `teardown_delete_refused`. They are
   recorded on the node (`cleanup_blocked_reason`, `cleanup_blocked_since`) from the shared
   funnel, raise the existing operator alert, survive cron re-diagnosis and the stranded sweep,
   and keep the full failure backoff (they cannot clear themselves).

## Implementation checklist

- [x] `NodeTeardownBlockedError` + reason codes in `strict-node-deletion-shared.ts`
- [x] Current-owner credential candidates with per-candidate fault isolation (rule 41)
- [x] Ownership proof (ID + labels) right before `deleteVM` on the fallback path, reusing
      `buildNodeProviderLabels` / `hasAmbiguousLabel`
- [x] Record blocked reason + alert from `deleteNodeResourcesStrict` (shared funnel)
- [x] Cron `handleCleanupFailure` keeps the typed reason; stranded sweep does not overwrite it
- [x] Owner DELETE response names the blocked reason
- [x] Tests (real SQL): incident shape through `replaceUserGcpCredential`, generation rotation,
      attack cases with owner controls, two installations, no-label instance, not-visible ->
      blocked + alert + two-sweep, already-absent on pinned path, owner DELETE / cron /
      NodeLifecycle entry points
- [x] Discrimination runs recorded (table in the PR body)
- [x] Docs: security architecture / node cleanup docs that describe credential rotation
- [x] Idea note for Raphaël: disconnecting a cloud account while nodes are alive (product
      decision), `capacity_source_id` NULL on GCP nodes (idea 01M76T4XXVQS1TX8VQM2BRPWFG, note
      2026-11-13 19:33Z)

## Acceptance criteria

- A node whose pinned credential row was deleted and replaced for the same owner is torn down
  with exactly one provider delete after ownership proof.
- A rotated generation on the same row is torn down.
- Another user's credential is never used; a mismatched installation/env/node/incarnation label,
  or a missing label set, never reaches `deleteVM`.
- No visible credential: named blocked reason, alert fired, no spin across two sweeps, reason
  survives retries.
- Pinned path behaviour (including already-absent 404) is unchanged.
- Staging: reproduce provision -> credential re-save -> delete; VM gone at the provider. (Verified 2026-11-14.)

## References

- `apps/api/.claude/rules/71-tightening-a-column-can-delete-a-capability.md`
- `packages/providers/.claude/rules/56-destructive-provider-ownership-proof.md`
- `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/74`, rule 47, rule 62

## Review follow-ups

- Deferred (LOW, security-auditor #4): `node-manual-deletion.ts` `providerStillHasServer` still
  checks only the pinned credential. Manual removal is offered only after strict delete failed, and
  strict delete now removes any VM a current credential can prove, so the residual is a VM whose
  delete failed transiently and that the owner then attests. Tracked on idea
  01M76T4XXVQS1TX8VQM2BRPWFG.
- Per-provider label encodings (Scaleway/Vultr/DigitalOcean tags, UpCloud labels, Infomaniak
  metadata) are not re-tested here; they are decoded by the same adapters provider-orphan
  reconciliation already relies on, and `nodeProviderLabelsMatch` is the same comparison.
- Staging verification (2026-11-14, exact head e7343e2, deploy 43535816263): GCP node
  01M7BS03XRFS78QVEYE52EM5YR pinned to credentials:01M7BB346E...; an identical WIF re-save replaced
  the row (01M7BS2M65D5PK3XBMMKPV463P); owner DELETE returned 200; GCP audit shows instances.delete by
  sam-vm-manager (op done 01:02:27Z); D1 deletion_finalized/explicit_terminal_proof; late audit at
  01:08:41Z clean. Pool restored semantically (the re-save moved GCP candidates to the new source, all
  disabled). Owner DELETE path only; cron/NodeLifecycle covered by automated tests. Earlier Hetzner
  pinned-path regression on 44b28cd5 passed.
- CodeRabbit review (2026-11-13 23:23Z, six findings) addressed:
  - User-tier candidate for project-attributed nodes.
  - GcpApiError and limit-aware refusal classification.
  - Continue to the next credential after a definitive delete refusal (new reason `teardown_delete_refused`).
  - Alert claim fenced to the runtime and episode.
  - Ambiguity test keeps the matching label.
  - Hetzner 403 classification handled in this module's classifier, not `HetznerProvider.getVM` (shared by other callers, rule 67).
