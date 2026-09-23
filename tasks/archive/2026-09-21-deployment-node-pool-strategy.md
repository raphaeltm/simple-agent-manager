# Deployment-specific node-pool strategy and resource reservations

## Problem

Deployment provisioning currently inherits the capacity pool's workspace-oriented strategy. A
pool using `pack` therefore ranks its largest allowed offering first even for a tiny app. Existing
deployment-node reuse also relies on exact native offering identity, an environment-count ceiling,
and load/memory heuristics instead of the resources declared by the deployment manifest.

Add a deployment-specific strategy inside each capacity pool. Deployment placement must aggregate
declared service resources into a persisted reservation, reuse compatible deployment nodes when the
aggregate reservation fits, and provision the smallest sufficient compatible offering otherwise.
Workspace `pack` semantics and persistent-volume exclusive nodes must remain unchanged.

Durable product source: SAM idea `01M30N3SR9APZ2E19Y87VHNSVA`.

## Research Findings

- `capacity_pools.strategy` is the only persisted scheduling strategy. `buildCapacityPoolSelection`
  applies it to both workspace and deployment candidates, while `compareCapacityCandidates` already
  implements both largest-first `pack` and reservation-aware `smallest-fit` ranking.
- Capacity candidates already carry concrete CPU, memory, and disk metadata. Candidate normalization
  filters candidates against the resolved reservation, but only workspace candidates subtract the
  configurable host-memory reserve.
- `resolveDeploymentPlacement` currently supplies a legacy small VM override and does not pass
  manifest-derived resource requirements. Its returned placement also omits the resolved reservation.
- Deployment environments persist no resource reservation. `findDeploymentNodeWithCapacity` and the
  final `linkEnvironmentToNode` write use an environment-count ceiling; advisory selection additionally
  compares raw load average to a percentage threshold. The final write does not sum CPU, memory, or disk.
- The repository rule `69-aggregate-capacity-at-final-reservation.md` requires the exact reservation
  snapshot to be persisted and every capacity/isolation invariant to be repeated in the final atomic
  reservation write. Missing or malformed occupied reservations must fail closed for co-tenancy.
- The deployment manifest already provides `resources.cpuLimit`, `resources.memoryLimitMb`, and volume
  `sizeHintMb`. Missing service declarations need explicit conservative defaults. Persistent volumes
  already force the exclusive-node path and remain outside shared-node reuse.
- Release submission owns the normalized manifest before provisioning, so it is the boundary where the
  aggregate reservation can be computed once and passed through placement and admission.
- Default capacity pools have an existing API and web editor for workspace strategy, exhaustion policy,
  node limit, and candidate supply. A deployment strategy belongs in that same policy response/update
  path while providers, locations, candidates, credentials, and quotas remain shared pool constraints.
- Migration changes can be additive: add a deployment strategy to `capacity_pools` and a reservation JSON
  snapshot to `deployment_environments`; do not recreate either FK-connected table.
- Relevant regressions live in `apps/api/tests/unit/deployment-provisioning.test.ts`,
  `apps/api/tests/unit/services/deployment-native-placement.test.ts`, capacity-pool route/service tests,
  migration tests, shared manifest tests, and the default capacity-pool web component tests.
- Prior provisioning incidents show that advisory checks are insufficient at concurrent lifecycle
  boundaries. Tests must exercise the real final database mutation and preserve placement authority.

## Implementation Checklist

- [x] Add shared deployment strategy and manifest-reservation types/defaults with deterministic aggregation
      of declared CPU, memory, disk, and explicit conservative defaults for missing service declarations.
- [x] Add safe additive migrations and Drizzle fields for capacity-pool deployment strategy and persisted
      deployment-environment reservation snapshots; update migration-chain coverage.
- [x] Thread deployment strategy through capacity-pool summaries, API validation, atomic policy updates,
      revision/digest authority, and the existing pool editor without duplicating supply constraints.
- [x] Make capacity selection use the workspace strategy for workspace workloads and the deployment strategy
      for deployment workloads; preserve workspace `pack` largest-allowed ordering.
- [x] Pass the manifest-derived environment reservation into canonical deployment placement so new deployment
      nodes use smallest-sufficient candidate ranking and subtract host memory reserve.
- [x] Replace count/load-only shared deployment-node selection with reservation-aware admission using trusted
      node capacity, live telemetry/disk-pressure safety, exact compatibility and placement authority.
- [x] Repeat aggregate CPU, memory, disk, reservation-validity, and exclusivity checks in the final atomic
      environment-to-node write, persisting the exact request reservation in the same mutation.
- [x] Preserve persistent-volume exclusive placement and ensure release submission carries one reservation
      snapshot consistently through placement, reuse, provisioning, and later audit surfaces.
- [x] Add focused tests for divergent workspace/deployment strategy ranking, declared-resource candidate sizing,
      existing-node reuse, dimension overflow, malformed legacy reservations, atomic final admission races,
      exact host-memory reserve boundaries, and persistent-volume exclusivity.
- [x] Update public compute-pool documentation and API/UI tests; run required desktop/mobile Playwright evidence
      if the existing pool editor changes.
- [x] Run focused scheduler/deployment tests and broader API checks plus repository lint, typecheck, formatting,
      migration-safety, node-pool-boundary, and full test-suite gates.
- [x] Run all required specialist reviews and address their findings; completion validation remains
      scheduled after staging and PR evidence are available.
- [ ] Coordinate staging use, deploy the final candidate, validate real declared-resource placement/reuse,
      clean up owned staging resources, then open the PR and complete CI, CodeRabbit, merge, and production
      deployment monitoring.

## Acceptance Criteria

- Capacity pools expose a deployment-specific strategy distinct from the workspace strategy while retaining
  shared provider, location, candidate, credential, quota, and cost boundaries.
- A pool can keep workspace `pack` largest-allowed behavior while a small declared deployment reservation
  selects the smallest sufficient deployment offering.
- Deployment release placement derives its reservation from explicit manifest resources; environment labels
  such as preview, staging, or production do not drive sizing.
- Compatible existing deployment nodes are reused only when current aggregate CPU, memory, and disk reservations
  plus the new request fit trusted capacity and live safety checks.
- When no existing deployment node fits, provisioning selects the smallest sufficient compatible candidate.
- The exact reservation used for admission is persisted atomically with placement; missing or malformed occupied
  reservation data cannot enable co-tenancy.
- Persistent-volume deployments continue to use exclusive deployment nodes.
- Existing pool strategy data migrates safely and API/UI behavior remains backward compatible.
- Focused tests, broader API validation, specialist review, staging evidence, CI, CodeRabbit, production deploy,
  and staging cleanup all complete successfully.

## References

- SAM idea `01M30N3SR9APZ2E19Y87VHNSVA`
- `apps/api/src/services/deployment-provisioning.ts`
- `apps/api/src/services/placement-capacity-ranking.ts`
- `apps/api/src/services/placement-resolver-capacity.ts`
- `apps/api/src/routes/deployment-release-submission.ts`
- `apps/api/src/db/schema.ts`
- `packages/shared/src/deployment-manifest/schema.ts`
- `apps/api/.claude/rules/31-migration-safety.md`
- `apps/api/.claude/rules/51-runtime-boundary-validation.md`
- `apps/api/.claude/rules/69-aggregate-capacity-at-final-reservation.md`
- `tasks/archive/2026-06-19-deployment-node-bin-packing.md`
- `tasks/archive/2026-08-07-fix-provisioning-node-cleanup-race.md`

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #2114 (`Add deployment-specific node pool placement (#2114)`). Its checklist reads 12/13 — the remaining boxes are stale. The audit verified the work, not the boxes, so they were left as-is rather than ticked without per-item evidence. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
