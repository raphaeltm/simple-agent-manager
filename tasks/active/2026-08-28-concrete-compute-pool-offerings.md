# Concrete compute-pool provider offerings

## Problem statement

The compute-pools integration branch currently models capacity-pool candidates around abstract SAM VM sizes (`small`, `medium`, `large`). That is not acceptable for pool identity: candidates must represent concrete provider offerings, including provider, region/location, provider-native instance type/SKU, and normalized capacity/price metadata. Abstract sizes may remain only as backward-compatible user/profile presets that resolve to resource requirements.

This task updates scheduler placement, reusable-node matching, and provisioning so the centralized placement resolver selects concrete provider offerings and providers receive the selected native instance type/SKU. Existing running nodes must not be killed when their source candidate is removed from a pool; pool edits affect future selection/provisioning and existing nodes drain through normal cleanup.

## Constraints

- Target existing branch: `sam/compute-pools-integration`.
- Do not deploy to staging.
- Do not merge.
- Push implementation changes to `sam/compute-pools-integration`.
- Preserve centralized placement resolution. Do not duplicate effective pool/provider/credential/runtime/placement decisions in task entry points.
- Direct `/do` task-file push to `main` was attempted from a clean main worktree and rejected by branch protection (`Durable Object Workers` required); this active task file is therefore tracked on the target integration branch.

## Research findings

- `apps/api/src/services/placement-resolver.ts` centralizes task placement and capacity-pool selection. Current `normalizeCapacityCandidate()` rejects candidates unless `candidate.machineSize` is a VM size, calls `canSatisfyVmSize()`, and then checks `candidateSatisfiesReservation()` through `PROVIDER_VM_CAPACITY`.
- `TaskStartCapacityCandidate` in `apps/api/src/services/placement-resolver-types.ts` currently stores `machineSize: VMSize` but has no provider-native instance type/SKU or normalized capacity/price fields.
- `packages/shared/src/types/capacity-pool.ts` and `apps/api/src/db/schema.ts` currently persist candidate `machine_class` and `machine_size`, but no `provider_instance_type`, `vcpu`, `memory`, `disk`, or price metadata.
- `apps/api/src/services/default-capacity-pools.ts` seeds default candidates from provider locations × `VM_SIZE_ORDER`, so candidate IDs are currently keyed by abstract size. This must change to provider-native offerings while leaving legacy size presets available for requested resource resolution.
- `apps/api/src/durable-objects/task-runner/node-provisioning-target.ts` applies the first selected capacity candidate by writing provider/location/machineSize into runner state. It needs to carry the concrete instance identity for provisioning while preserving legacy `vmSize`.
- `apps/api/src/services/nodes.ts` calls `provider.createVM()` with `size: node.vmSize`. `packages/providers/src/types.ts` `VMConfig` lacks a concrete instance type field, so providers cannot currently receive a pool-selected SKU.
- Provider implementations already know their default provider-native types through `Provider.sizes[vmSize].type`: Hetzner `server_type`, Scaleway `commercial_type`, DigitalOcean `size`, Vultr/UpCloud `plan`, GCP `machineType`, Infomaniak flavor name. The compatibility path is to add an optional provider-native instance type/SKU to `VMConfig` and have providers prefer it when present.
- Node reuse in `apps/api/src/durable-objects/task-runner/node-selection.ts` and `apps/api/src/services/node-selector.ts` still uses `canSatisfyVmSize()` for requested size compatibility. For pool-aware nodes it should match candidate identity/resources; for legacy nodes that only have `vm_size`, the current compatibility behavior must remain.
- `resolveReusableNodeCapacitySnapshot()` currently attempts to match a node to active candidates. If a node's historical candidate has been disabled or removed from the current pool, it must be excluded from future placement without deleting or otherwise disrupting the running node; normal drain/cleanup behavior handles it later.
- Existing tests to extend: `apps/api/tests/unit/services/placement-resolver.test.ts`, `apps/api/tests/unit/durable-objects/task-runner-node-selection.test.ts`, `apps/api/tests/unit/durable-objects/task-runner-size-fallback.test.ts`, `apps/api/tests/unit/services/default-capacity-pools.test.ts`, `packages/shared/tests/unit/capacity-pool.test.ts`, and provider provisioning slice tests where concrete instance type payloads can be asserted.
- Public docs still describe VM size as a user-facing workspace profile input (`apps/www/src/content/docs/docs/guides/creating-workspaces.md`). That can remain true, but any new docs or comments must be honest that compute-pool candidates are provider-native offerings.

## Relevant process lessons

- `.claude/rules/10-e2e-verification.md`: selection logic with compatibility constraints must reject incompatible high-ranking candidates before sorting and cover production selector/step handlers, not helper-only tests.
- `.claude/rules/35-vertical-slice-testing.md`: cross-boundary placement/provisioning tests need realistic state through D1/DO/provider boundaries.
- `.claude/rules/47-control-loop-io-budget.md`: scheduler/candidate-selection changes need explicit candidate volume and cost awareness. This task changes synchronous placement/filtering over already-loaded default-pool candidates; it must not add per-candidate network I/O.
- `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`: central resolver migration is complete and must not regress into duplicated entry-point placement logic.
- `tasks/archive/2026-08-07-fix-hetzner-422-capacity-backoff.md`: provider-facing behavior needs production-shaped payload/contract tests, not idealized mocks.
- `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`: removed/drained node behavior must not use a stale selector predicate to destroy or strand existing nodes.

## Implementation checklist

- [x] Add provider-native offering fields to capacity-pool candidate shared types and D1 schema/migrations: instance type/SKU, normalized vCPU, memory, optional disk, optional price metadata.
- [x] Update capacity-pool row mappers and placement snapshots/explanations so candidate metadata is available to resolver/task runner without secrets.
- [x] Update default candidate generation to seed concrete provider offerings from provider/catalog metadata: provider + ordered location + provider instance type/SKU + normalized resources/price. Keep abstract size only as a backward-compatible preset/source field, not candidate identity.
- [x] Replace placement filtering dependency on `isVmSize`, `canSatisfyVmSize`, and `VM_SIZE_RANK` for capacity-pool candidates with normalized resource checks against `ResolvedResourceReservation` (`cpuMillis`, `memoryMb`; disk only if safe with existing normalized data).
- [x] Update candidate scoring for `smallest-fit`, `pack`, balanced/cost-oriented ordering using actual normalized capacity, price, priority, candidate order, and stable IDs.
- [x] Update reusable-node matching so concrete candidate identity/resources are used when present, and legacy `vm_size` compatibility remains for nodes without concrete offering metadata.
- [x] Ensure nodes whose historical pool candidate was removed/disabled are excluded from future placement without killing the running node; normal drain/cleanup behavior remains responsible for idle cleanup.
- [x] Thread selected provider instance type/SKU through `TaskRunnerState`, node record creation, task/node/workspace placement snapshots, and `provisionNode()`.
- [x] Update `VMConfig` and provider `createVM()` implementations so a selected provider-native instance type/SKU is sent to each provider, while legacy size fallback still works when no concrete pool/catalog candidate exists.
- [x] Preserve VM-size fallback semantics for legacy non-pool provisioning and avoid descending from a concrete pool-selected offering unless the pool explicitly supplies multiple candidates through the centralized resolver.
- [x] Add/adjust tests for centralized resolver behavior, concrete candidate selection, resource matching, candidate scoring, legacy profile size compatibility, removed-candidate drain behavior, and concrete provider createVM payloads.
- [ ] Update docs/comments only where needed for honesty; do not add public strategy docs.
- [ ] Run targeted and full local validation; skip staging by explicit user instruction; do not merge.

## Acceptance criteria

- [x] Capacity-pool candidates are concrete provider offerings and include provider, location, provider instance type/SKU, normalized vCPU/memory, optional disk, and price metadata.
- [x] Abstract `small|medium|large` remains usable as a legacy input/profile preset that maps to requested resources, but is not the identity or capacity gate for pool candidates.
- [x] Centralized resolver selects and ranks concrete offerings using normalized resources, price, priority, and strategy; task entry points do not duplicate placement logic.
- [x] Workloads requiring more vCPU or memory reject undersized candidates even if those candidates would otherwise rank first.
- [x] Smallest-fit and pack-style strategies choose concrete offerings according to actual capacity/price/priority, not VM-size rank.
- [x] Existing nodes provisioned from a candidate that has since been removed/disabled are not killed by placement changes, are excluded from future placement, and drain through normal cleanup.
- [x] New pool-selected provisioning passes the provider-native instance type/SKU to provider `createVM()`; legacy no-pool provisioning still uses `vmSize`.
- [x] Tests cover resolver, default candidate generation, task-runner node reuse/provisioning, provider payloads, legacy VM-size compatibility, and removed-candidate behavior.

## Integration notes

- If a parallel catalog/backend task lands different field names for provider-native offering identity or price metadata, adapt the names in one place: shared `CapacityPoolCandidate`, D1 candidate schema/migration, and `default-capacity-pools` seeding.
- This task should not wait on a live provider catalog API. The desired shape can be implemented against existing provider static metadata and later wired to dynamic catalogs.

## References

- `apps/api/src/services/placement-resolver.ts`
- `apps/api/src/services/placement-resolver-types.ts`
- `apps/api/src/durable-objects/task-runner/node-selection.ts`
- `apps/api/src/durable-objects/task-runner/node-steps.ts`
- `apps/api/src/durable-objects/task-runner/node-provisioning-target.ts`
- `apps/api/src/services/node-selector.ts`
- `apps/api/src/services/default-capacity-pools.ts`
- `apps/api/src/services/nodes.ts`
- `packages/providers/src/types.ts`
- `packages/shared/src/types/capacity-pool.ts`
- `packages/shared/src/constants/resource-defaults.ts`
- `packages/shared/src/constants/vm-sizes.ts`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`
