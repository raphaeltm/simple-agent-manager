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

## Review Findings and Disposition

Two local reviewers ran against commit `bcde067cf`. All four actionable findings were
verified against the code before acting; every one was real and is fixed in the follow-up
commit.

| Reviewer                  | Finding                                                                                                                                                                                                               | Severity           | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task-completion-validator | `project.defaultProvider` / `defaultLocation` are set on the same Infrastructure tab and feed `resolveProvider()` / `resolveVmLocation()` in `placement-resolver.ts`, but the guide never mentioned them              | HIGH               | Fixed — new "The other settings on the same page" and "Default provider and region" sections. Verified the asymmetry the reviewer did not state: provider is a hard candidate filter (`placement.provider && candidate.provider !== placement.provider`), whereas a project default region is only a preference — only `explicitVmLocation` pins placement (`placement-resolver.ts:250`, `placement-resolver-capacity.ts:335`). |
| task-completion-validator | Warm timeout, max workspaces per node, and CPU/memory thresholds were presented as fixed platform defaults although they are per-project overrides consumed by `resolveWorkspaceAdmissionPolicy(env, projectScaling)` | HIGH               | Fixed — noted as project-overridable in both "When a machine can be shared" and "Warm reuse". Confirmed the disk-pressure threshold is genuinely not in `SCALING_PARAMS`, so it is still described as deployment-set.                                                                                                                                                                                                           |
| doc-sync-validator        | "Fail: stop immediately" is untrue for provider **account-wide** exhaustion                                                                                                                                           | MEDIUM             | Fixed — added a caution. Verified in `node-provisioning-step.ts`: the `recordVmProviderCapacityFailure` branch calls `waitForVmAdmissionCapacity` and returns _before_ the `exhaustionPolicyQueues(exhaustionPlan)` gate, so it waits under every policy including `fail`. Per-offering `transient_capacity` does respect the policy.                                                                                           |
| doc-sync-validator        | "leaving a reserve for the host itself" overstates the default                                                                                                                                                        | LOW                | Fixed — only memory reserves by default (512 MB). `cpuShareBudgetPercent` defaults to 100 and the disk check compares against the whole disk.                                                                                                                                                                                                                                                                                   |
| task-completion-validator | `guides/idea-execution.md` already used the phrase "effective compute pool" but was not cross-linked                                                                                                                  | MEDIUM             | Fixed — linked.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| task-completion-validator | Workspace Idle Timeout sits next to the warm timeout and is easy to conflate                                                                                                                                          | LOW                | Fixed — one-note disambiguation in "Warm reuse".                                                                                                                                                                                                                                                                                                                                                                                |
| task-completion-validator | `project.nodeIdleTimeoutMs` is a persisted, validated UI field with no consumer anywhere in `apps/api`                                                                                                                | LOW (out of scope) | Confirmed independently and filed as `tasks/backlog/2026-09-09-node-idle-timeout-project-setting-has-no-consumer.md`. Correctly excluded from the guide — documenting a no-op control would be worse than omitting it.                                                                                                                                                                                                          |
| doc-sync-validator        | "Pending add" offering label omitted                                                                                                                                                                                  | LOW                | No change. It is a client-side unsaved-draft indicator, never persisted; the guide documents persisted states.                                                                                                                                                                                                                                                                                                                  |

### Additional defect found during re-verification (not reported by either reviewer)

Re-measuring the rendered page after the review fixes showed table **cells** extending past
the right edge of a 375px viewport — 25 cells, the furthest at 557px. Neither standard guard
sees this: `documentElement.scrollWidth > innerWidth` is false because the document does not
grow, and a clipped-overflow walk finds nothing because no ancestor sets
`overflow-x: hidden|clip`. The content is simply rendered outside the viewport, unreachable.

The four three-column tables were converted to two-column tables and one definition list.
`compute-pools` now measures **0** cells past the viewport at 375px.

Measurement showed this is a pre-existing, site-wide pattern rather than a regression:
`instant-sessions` 24 cells / 609px, `agents` 30 / 428px, `idea-execution` 20 / 530px.
Those were left alone to keep this PR scoped, and are tracked in
`tasks/backlog/2026-09-09-docs-site-table-cells-overflow-on-mobile.md`, which also proposes
adding a per-cell assertion to the www Playwright suite and to
`.claude/rules/56`.

## Notes

- The `user` layer exists in `ResourceResolutionInput` but no table stores it
  (`resource_requirements_json` exists on projects, tasks, workspaces, agent
  profiles, skills and triggers only), so the guide documents it as reserved
  rather than as a settable layer.
- `maxCoTenants` is resolvable through the API but is not exposed in
  `ResourceRequirementsInput`, so the guide marks it API-only.
