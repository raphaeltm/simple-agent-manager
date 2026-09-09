# Document compute (node) pools on the docs site

## Problem

The public docs site (`apps/www`) does not explain compute pools — the mechanism
that decides which cloud machines SAM is allowed to rent, how much machine a piece
of work asks for, and how a node is chosen or reused. The only coverage is:

- one paragraph in `docs/concepts.mdx` ("Infrastructure Compute Pools add a
  lower-level control surface…"),
- an API contract section in `docs/reference/api.md`,
- scattered environment-variable rows in `docs/reference/configuration.md`.

None of that tells a user what the **Infrastructure** settings panel does, what
**Strategy** or **Exhaustion policy** mean, why a pool says "Empty — no eligible
offerings", or where to set resource requirements.

## Acceptance Criteria

- [x] A new user-facing guide explains pools end to end: scopes and precedence,
      sources, allowed offerings, reconcile, strategy, exhaustion policy,
      resource requirements and their precedence, node reuse/co-tenancy, pool
      states, and troubleshooting.
- [x] Every parameter exposed in the UI is documented with its real behaviour and
      real default, verified against the implementation (not assumed).
- [x] The guide is reachable from the docs sidebar and cross-linked from the
      pages a reader would arrive from (concepts, workspaces, configuration).
- [x] Terminology covers what users actually call it: "compute pool", "capacity
      pool", and "node pool" all lead to this page.
- [x] `pnpm --filter @simple-agent-manager/www build`, `lint`, `typecheck` and
      `check:links` pass.

## Implementation Checklist

- [x] Research the implementation (types, resolver, strategy, exhaustion, admission,
      reconcile, UI panels) so every claim is grounded.
- [x] Write `apps/www/src/content/docs/docs/guides/compute-pools.md`.
- [x] Add the guide to the Starlight sidebar in `apps/www/astro.config.ts`.
- [x] Cross-link from `concepts.mdx`, `guides/creating-workspaces.md`,
      `reference/configuration.md`, and `reference/api.md`.
- [x] Run the www build/lint/typecheck/link checks.

## Verified Behaviour (source of every claim)

| Claim                                                                           | Verified against                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scopes and precedence project → user → installation; no cross-pool fallback     | `apps/api/src/services/capacity-pool-precedence.ts`                                                                                                                                                                                                  |
| Strategy ordering keys                                                          | `apps/api/src/services/placement-strategy.ts` (`PLACEMENT_STRATEGY_HOST_ORDERING`, `compareStrategyDefiningKey`)                                                                                                                                     |
| Exhaustion policy behaviour                                                     | `apps/api/src/durable-objects/task-runner/node-provisioning-exhaustion.ts`                                                                                                                                                                           |
| Queue wait ceiling (2 h)                                                        | `VM_ADMISSION_WAIT_TIMEOUT_MS` in `docs/reference/configuration.md`                                                                                                                                                                                  |
| New-pool defaults `balanced` + `queue`                                          | `apps/api/src/services/default-capacity-pools.ts` (`DEFAULT_POOL_STRATEGY`, `DEFAULT_EXHAUSTION_POLICY`)                                                                                                                                             |
| Pool states and their causes                                                    | `apps/api/src/services/default-capacity-pool-summaries.ts` (`defaultPoolEffectiveState`)                                                                                                                                                             |
| Resource fields and platform defaults (2 vCPU / 4 GB / 40 GB, `maxCoTenants` 4) | `packages/shared/src/constants/resource-defaults.ts` (`PLATFORM_RESOURCE_DEFAULTS`)                                                                                                                                                                  |
| Requirement precedence chain                                                    | `packages/shared/src/types/resource.ts` (`ResourceResolutionInput`), `apps/api/src/services/resource-requirements-input.ts`                                                                                                                          |
| Candidate eligibility filters                                                   | `apps/api/src/services/placement-resolver-capacity.ts` (`normalizeCapacityCandidate`)                                                                                                                                                                |
| Admission gates and co-tenancy                                                  | `apps/api/src/services/workspace-resource-capacity.ts` (`evaluateWorkspaceReservationCapacity`)                                                                                                                                                      |
| Node reuse requires identical pool/source/offering identity                     | `apps/api/src/services/placement-authority.ts`                                                                                                                                                                                                       |
| Reconcile preserves explicit removals; non-legacy catalog rows start disabled   | `apps/api/src/services/default-capacity-pool-candidates.ts` (`initialStatusForProviderOffering`)                                                                                                                                                     |
| UI surfaces and copy                                                            | `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`, `apps/web/src/components/hardware/EffectivePoolSummary.tsx`, `PlacementDecisionSummary.tsx`, `apps/web/src/components/resource-requirements/ResourceRequirementsInput.tsx` |

## Notes

- The `user` layer exists in `ResourceResolutionInput` but no table stores it
  (`resource_requirements_json` exists on projects, tasks, workspaces, agent
  profiles, skills and triggers only), so the guide documents it as reserved
  rather than as a settable layer.
- `maxCoTenants` is resolvable through the API but is not exposed in
  `ResourceRequirementsInput`, so the guide marks it API-only.
