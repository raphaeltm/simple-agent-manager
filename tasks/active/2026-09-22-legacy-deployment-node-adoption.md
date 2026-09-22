# Legacy deployment node adoption (production incident 2026-09-21)

## Problem

Environments already running on pre-node-pool deployment nodes can no longer
receive releases, and the resulting placement failure tears the running app
down.

Production environment `01M100A361P49T716X6QBV2NV5` (project APEX, name
`production`, `requires_volumes=1`, hetzner/fsn1) is linked to node
`01M1015FQ9D772EF6HHB5AGZ0Z`. Release v15 (`01M32DYXWVG1Y5W57X5EB9Z2SM`) failed
at 2026-09-21T16:49:35Z with:

```
observed_error_message = "Deployment node placement failed: Existing exclusive
deployment node cannot admit the declared resource reservation"
```

v14 (`01M2PKNZXH32QM324BD7KTR0KS`) was `applied` and running. Within one
heartbeat of that _placement_ failure the node reported
`deployment.environments = []` — the running v14 app had been torn down.

Node `01KXAR1T3XCQKKPBEJEERQ2PSZ` (July, same shape, hosts env
`01KX9SB1KCRTE5YK0X35MCCVDN`) will hit the same failure on its next release.

## Research findings

### 1. PR #2114 made every linked environment go through pooled admission

`placeReleaseOnDeploymentNode` (`apps/api/src/routes/deployment-release-placement.ts:685`)
calls `reserveExistingNodeForRelease` (same file, `:552`) for any environment
that already has a `node_id`. That helper runs
`findDeploymentNodeWithCapacity` (`apps/api/src/services/deployment-node-admission.ts:76`)
and `linkEnvironmentToNode` (`:279`).

Both require pooled/observed identity that pre-node-pool nodes do not have:

- `resolveReusableNodeCapacitySnapshot`
  (`apps/api/src/services/placement-resolver-capacity.ts:169`) returns
  `undefined` for a node with no `capacity_pool_id` — "Legacy nodes drain once
  any effective pool exists".
- `linkEnvironmentToNode`'s `runningCapacitySql`
  (`deployment-node-admission.ts:339`) requires
  `observed_hardware_source = 'observed'` and observed vcpu/memory/disk > 0.
- `deploymentNativeIdentityPredicate` (`:61`) requires
  `provider_instance_type`, `provider_instance_boot_disk_size_gb`,
  `provider_instance_image`, `provider_instance_architecture` to match.

Production node `01M1015FQ9D772EF6HHB5AGZ0Z`: status running, healthy,
`node_role=deployment`, `node_mode=exclusive`, hetzner/fsn1, user
`4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx`, `provider_instance_id=163715232`,
heartbeating every minute — and `capacity_pool_id`, `workload_role`,
`provider_instance_type`, `observed_hardware_source`, every `observed_*` all
NULL.

→ Checklist item A.

### 2. The failure path was destructive

`markDeploymentReleasePlacementFailed`
(`deployment-release-placement.ts:143`, pre-change) set
`deployment_environments.status = 'error'`. The node heartbeat handler
(`apps/api/src/routes/node-lifecycle.ts:574-611`) only treats
`status IN ('active','starting')` as placed on the node; every environment the
node reports that is not in that set goes into `retireEnvironments`, and the VM
agent then tears the app down (compose down, unmount volumes, remove the Caddy
site).

The same handler only advertises `pendingReleases` for `active`/`starting`
environments (`node-lifecycle.ts:722-727`), and the only transition out of the
`error` state is `'starting'` → `'active'` when the node reports a release
applied (`node-lifecycle.ts:625-627`). An environment parked in `error` by a
placement failure therefore never receives another release.

→ Checklist items B and C.

### 3. Volume attachment can never succeed on a legacy node, so it must be skipped

`attachVolumesForRelease` calls `claimDeploymentEnvironmentRelocation`, whose
`buildPlacementAuthoritySqlPredicate` requires
`COALESCE(n.workload_role,'workspace') = 'deployment'`. A legacy node has
`workload_role` NULL, so the claim can never be issued. Left as-is, every legacy
release would throw `RelocationClaimLostError`, which
`attachVolumesToExistingNode` swallows — but only after logging it at `error`
severity on every single release.

The attach is also unnecessary: the environment's volumes are already attached
to the node's `provider_instance_id`, which is exactly what the heartbeat's
`deploymentVolumesReadyForNode` gate (`node-lifecycle.ts:94`) checks before
advertising the release.

→ Checklist item A (skip the attach and log one `info` event instead).

## Implementation checklist

- [x] **A.** New `apps/api/src/services/deployment-legacy-node-admission.ts`
      exporting `linkEnvironmentToLegacyNode`, performing ONE atomic
      `UPDATE deployment_environments AS de ... FROM nodes n` that repeats every
      invariant in its own predicate (`.claude/rules/69`): environment already
      linked to this node, node owned by the release's user, running, healthy,
      `node_role='deployment'`, legacy-shaped (`capacity_pool_id`,
      `observed_hardware_source`, `provider_instance_type` all NULL), node mode
      exclusive when the release requires it, occupancy within the node mode's
      cap, release fence on the newest release, reservation CAS, relocation
      claim fence.
- [x] **A.** Re-export from `apps/api/src/services/deployment-provisioning.ts`.
- [x] **A.** Call it from `placeReleaseOnDeploymentNode` after
      `reserveExistingNodeForRelease` returns false and before
      `handleExistingNodeReservationFailure`.
- [x] **A.** After a successful legacy adoption, skip
      `attachVolumesToExistingNode` (it can never obtain a relocation claim on a
      legacy node) and emit one
      `log.info('deployment_release.legacy_node_volume_attach_skipped', …)`
      instead of an `error`-severity log on every legacy release.
- [x] **A.** Import the shared `DEPLOYMENT_RELOCATION_CLAIM_FIELD` from
      `deployment-node-admission.ts` (now exported) rather than redeclaring the
      literal.
- [x] **B.** `markDeploymentReleasePlacementFailed` no longer sets
      `status='error'` when the environment still has a node AND an `applied`
      release. `observed_status`/`observed_error_message` and the release
      `failed` row are still written. Mirrored in the drizzle fallback.
- [x] **B.** Extracted `markDeploymentReleasePlacementFailed` into
      `apps/api/src/services/deployment-release-failure.ts` so
      `deployment-release-placement.ts` stays under the 800-line ceiling
      (`.claude/rules/18`).
- [x] **C.** `apps/api/tests/unit/services/deployment-legacy-node-admission.test.ts`
      — real SQL engine (`createSqliteD1` + `createAllSchemaTables`), seeded
      with the exact production row shapes; owner paths, thirteen refusal
      controls, and the fix-B preserve/flip cases driven through
      `placeReleaseOnDeploymentNode`.
- [x] **C.** Extended
      `apps/api/tests/unit/routes/deployment-release-provisioning.test.ts` with
      legacy-adoption success (exclusive + shared) and a refusal regression
      control.
- [x] **C.** Discrimination proofs recorded (see below).

## Acceptance criteria

- [x] An environment already linked to a legacy deployment node receives its
      release on that node instead of failing placement.
- [x] The adoption flips `status` from `error` to `starting` (and clears
      `observed_error_message`) so the heartbeat advertises the release again;
      an `active` environment keeps `active`.
- [x] Legacy adoption never touches a pooled node, a node with trusted observed
      hardware, a node the environment is not linked to, an occupied exclusive
      node, another user's node, a non-running or unhealthy node, a
      non-deployment node, a shared node for a volume-bearing release, a stale
      release, or a CAS/relocation-claim mismatch.
- [x] A failed placement no longer flips an environment with a running
      (`applied`) release to `error`, so the heartbeat cannot retire it.
- [x] Environments with no node or no applied release still go to `error`.
- [x] A legacy release never attempts the relocation claim it cannot obtain; the
      skip is recorded as a single `info` event.
- [x] `pnpm --filter @simple-agent-manager/api typecheck`, `lint`, and the full
      api vitest suite pass.

## Discrimination proofs

| Guard removed                                                                 | Tests that went red                                                                                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AND n.capacity_pool_id IS NULL` in `linkEnvironmentToLegacyNode`             | exactly `refuses a pooled node (capacity_pool_id set)` (1 failed / 20 passed)                                                                                   |
| the `status = CASE WHEN <live deployment> THEN status ELSE 'error' END` fix   | `leaves status untouched while a release is still applied on the node` (plus the pre-existing SQL-shape assertion in `deployment-release-provisioning.test.ts`) |
| the `linkEnvironmentToLegacyNode` call site in `placeReleaseOnDeploymentNode` | all 4 adoption tests across both files                                                                                                                          |
| the `requiresVolumes && adoptedLegacyNode` volume-attach skip                 | `adopts the legacy node … ('exclusive (requiresVolumes)')` and `adopts through the real release placement entry point` (2 failed / 40 passed)                   |
