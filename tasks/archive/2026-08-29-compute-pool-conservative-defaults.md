# Compute pool conservative defaults

## Problem statement

PR #1943 (`sam/compute-pools-integration`) now discovers the full provider-native
compute catalog, including large and expensive Hetzner offerings. The editor should
show that full catalog so users can explicitly add/remove concrete offerings, but
default pool creation and legacy migration must not preselect every live provider SKU.

The user-visible failure on staging is a dangerous default: upgraded/default SAM
installs can end up with far too many active offerings, including very expensive
nodes. Desired invariant: **DISCOVER BROADLY; SELECT CONSERVATIVELY**.

## Constraints

- Create a new child PR from PR #1943 head (`sam/compute-pools-integration`) and
  target/base the child PR at `sam/compute-pools-integration`, not `main`.
- Do not push implementation commits directly to `sam/compute-pools-integration`.
- Do not merge PR #1943 or the child PR.
- Commit only this task file to `main`; implementation work goes on the child
  feature branch.
- Preserve full provider-native catalog visibility/editing at installation, user,
  and project scopes.
- Avoid price-based heuristics. Default active selection must be based on concrete
  legacy-supported provider SKU metadata.
- Preserve previously user-disabled/deleted/removed offerings and explicit user
  additions across reconciliation.
- Keep `small|medium|large` internal as migration/profile hints only, not
  user-facing pool add choices.
- Staging validation must clean up all created workspaces/nodes/VMs; staging should
  return to zero VMs/nodes at rest because the shared Hetzner account is capped at
  10 servers.

## Research findings

- PR #1943 is draft/open, base `main`, head `sam/compute-pools-integration`, head
  SHA `cb3787bcff56e2f2b629506501b61155434e23cc`.
- The current checkout was already at the PR #1943 head, but on SAM output branch
  `sam/execute-task-using-skill-m7nhet`. It also had an unrelated modified
  `.codex/config.toml`; this task must not include that file.
- `apps/api/src/services/default-capacity-pool-candidates.ts` contains the likely
  bug: `ensureCandidatesForSource()` sets each currently selectable live offering
  to `active` unless a matching legacy `small|medium|large` row was
  disabled/deleted. This broad activation is correct for discovery rows but wrong
  for default selected rows.
- The same file already has the right seam to extend: deterministic native
  candidate IDs via `defaultCandidateId()`, old legacy IDs via
  `legacyDefaultCandidateId()`, and `legacyVmSizeHintForOffering()` which maps a
  concrete provider-native offering back to a legacy hint.
- Legacy Hetzner mapping is verified from current code, not assumed:
  `packages/providers/src/hetzner-metadata.ts` maps `small -> cx23`,
  `medium -> cx33`, and `large -> cx43`; `packages/providers/tests/unit/instance-offerings.test.ts`
  pins the same list.
- Provider static metadata for all providers is exposed by
  `packages/providers/src/instance-offerings.ts:getProviderInstanceOfferings()`.
  This is the durable source for legacy-supported concrete SKUs.
- Hetzner live catalog rows are mapped in
  `packages/providers/src/hetzner-instance-offerings.ts:mapHetznerServerTypeOfferings()`
  and include per-location API catalog metadata, normalized resources, and EUR
  price data. Official Hetzner Cloud API docs confirm `server_types` expose
  available server types with hourly/monthly prices.
- `apps/api/src/services/provider-catalogs.ts` exposes full provider catalogs for
  user, project, and installation scopes from active credentials. This path should
  remain broad.
- `apps/api/src/services/default-capacity-pool-updates.ts` already supports explicit
  `catalogAdditions` and candidate status updates; explicit non-default adds must
  stay active after reconciliation.
- `apps/api/src/services/placement-resolver-capacity.ts` already filters scheduler
  candidates through `isActiveCapacityPlacementOption(pool, source, candidate)`.
  Add a focused regression so disabled catalog-visible offerings cannot be selected.
- `apps/api/tests/unit/services/default-capacity-pools.test.ts` currently contains
  expectations that all live catalog offerings become active by default, including
  the `cpx62` API offering. These tests should be changed to assert catalog rows
  are created but non-legacy rows default to disabled.
- Existing preservation tests cover disabled/deleted candidate persistence and
  pre-native legacy deletion translation. They must be kept and tightened for the
  new policy.
- Existing UI code in `apps/web/src/components/project-settings/ComputePoolOfferingsManager.tsx`
  already labels non-selected catalog entries as `Catalog only` and exposes add
  actions. `DefaultCapacityPoolsPanel.tsx` copy already says reconcile refreshes
  catalog rows without re-enabling removed offerings. UI changes may be unnecessary
  unless screenshots show confusion.
- Public docs already state compute pools use provider-native catalogs and legacy
  small/medium/large prices are examples only:
  `apps/www/src/content/docs/docs/reference/api.md`,
  `apps/www/src/content/docs/docs/guides/recent-product-changes.md`, and
  `apps/www/src/content/docs/docs/guides/self-hosting.mdx`.
- Relevant task records:
  - `tasks/active/2026-08-29-compute-pools-integration-quality-pass.md`
  - `tasks/active/2026-08-28-repair-compute-pool-default-editing.md`
  - `tasks/archive/2026-08-28-concrete-compute-pool-offerings.md`
  - `tasks/archive/2026-08-28-provider-native-compute-pool-ui.md`
  - `tasks/archive/2026-08-28-wave-2a-placement-resolver-migration.md`
- Relevant process lessons:
  - `.claude/rules/09-task-tracking.md`: every finding must map to a checklist item;
    task-completion-validator is mandatory before archive.
  - `.claude/rules/10-e2e-verification.md` and
    `.claude/rules/35-vertical-slice-testing.md`: selection compatibility must be
    proven through representative production paths, not helper-only tests.
  - `.claude/rules/13-staging-verification.md` and
    `.claude/rules/30-never-ship-broken-features.md`: deploy to staging and verify
    the real feature end-to-end before PR handoff.
  - `.claude/rules/17-ui-visual-testing.md`: if UI changes are made, capture and
    review desktop/mobile screenshots with stress data and post them to the PR.
  - `tasks/archive/2026-08-06-fix-node-reaping-orphan-reconciliation.md`: staging
    capacity is scarce; cleanup evidence is mandatory.
  - `.claude/rules/47-control-loop-io-budget.md`: reconciliation should remain
    bounded/chunked and avoid per-candidate network calls.

## Implementation checklist

- [x] Add a testable policy helper such as `initialStatusForProviderOffering(...)`
      that returns active only for legacy-supported concrete provider SKUs on first
      default creation/migration, and disabled for non-legacy catalog discoveries.
- [x] Distinguish existing explicit native candidate status from legacy migration
      status: existing native active/disabled/deleted must win; legacy
      disabled/deleted should transfer only to the matching concrete legacy SKU.
- [x] Preserve full catalog row creation/tracking during reconciliation for
      installation, user, and project default pools.
- [x] Ensure non-legacy full-catalog discoveries default to disabled/catalog-only,
      not active, without relying on price thresholds.
- [x] Preserve explicit user additions of non-default catalog offerings as active
      across subsequent reconciliation.
- [x] Preserve disabled/deleted/removed offerings across reconciliation and prevent
      broad reactivation.
- [x] Keep legacy `small|medium|large` values as `machineSize` migration/profile
      hints only and verify user-facing pool add choices remain concrete SKUs.
- [x] Add/update service tests proving full catalog rows are created but only
      legacy-supported concrete SKUs are active by default, including Hetzner
      `cx23/cx33/cx43` and an expensive non-legacy offering.
- [x] Add tests for project/user/installation scopes, explicit non-legacy catalog
      add persistence, and disabled/deleted preservation.
- [x] Add/update placement tests proving scheduler selection ignores disabled
      catalog-visible offerings.
- [x] Add/adjust web unit and Playwright tests only if UI code/copy changes are
      needed; otherwise run existing compute-pool Playwright audits with stress data.
- [x] Run focused tests after implementation, then full `pnpm lint && pnpm typecheck
      && pnpm test && pnpm build`.
- [ ] Run mandatory specialist reviews: task-completion-validator,
      cloudflare-specialist, constitution-validator, test-engineer, and UI review
      if `apps/web` changes or screenshot evidence is refreshed.
- [ ] Deploy child branch to staging and verify full Hetzner catalog visible/addable,
      default active set limited to legacy concrete SKUs, expensive offerings
      available but not selected, real VM prompt/session provisions through an active
      selected offering, and cleanup returns staging to zero VMs/nodes at rest.
- [ ] Open draft child PR targeting `sam/compute-pools-integration`, trigger
      CodeRabbit with the `coderabbit-review` label, address/document actionable
      feedback, and post required evidence on child and parent PRs.

Workflow-gate status: the remaining unchecked review, staging, and PR evidence
items are tracked in `.do-state.md` and will be completed after the Phase 4
archive commit per the `/do` phase ordering.

## Acceptance criteria

- Full provider-native offerings are discovered and visible/addable while editing
  installation, user, and project pools.
- Default reconciliation creates/tracks rows for full offerings but active-selects
  only concrete provider SKUs that match old SAM-supported small/medium/large
  metadata.
- For Hetzner, the preselected defaults are exactly the currently verified legacy
  mappings `cx23`, `cx33`, and `cx43` for each visible/defaulted location; expensive
  non-legacy offerings remain disabled/catalog-only until explicitly added.
- Existing explicit native candidate statuses survive reconciliation, including
  active user additions and disabled/deleted removals.
- Scheduler/placement considers only active selected candidates and ignores
  disabled catalog-visible rows.
- No user-facing compute-pool add UI exposes `small|medium|large` as selectable pool
  offerings.
- Automated tests cover conservative default status, explicit non-legacy add
  persistence, disabled/deleted preservation, scheduler filtering, and all relevant
  scopes.
- Playwright desktop/mobile screenshots show full catalog visibility with limited
  active defaults and expensive disabled offerings; screenshots are QC-reviewed and
  posted to the child PR.
- Staging deploy succeeds; live staging validation proves the behavior and real VM
  provisioning through an active offering; cleanup leaves staging at zero VMs/nodes
  at rest.
- Child PR remains draft/open against `sam/compute-pools-integration`, CodeRabbit is
  label-triggered and handled, and neither PR is merged.

## References

- Parent PR #1943: <https://github.com/raphaeltm/simple-agent-manager/pull/1943>
- Hetzner Cloud API docs: <https://docs.hetzner.cloud/reference/cloud>
- `apps/api/src/services/default-capacity-pool-candidates.ts`
- `apps/api/src/services/default-capacity-pools.ts`
- `apps/api/src/services/default-capacity-pool-updates.ts`
- `apps/api/src/services/placement-resolver-capacity.ts`
- `apps/api/src/services/provider-catalogs.ts`
- `packages/providers/src/instance-offerings.ts`
- `packages/providers/src/hetzner-metadata.ts`
- `packages/providers/src/hetzner-instance-offerings.ts`
- `packages/shared/src/types/capacity-pool.ts`
- `packages/shared/src/types/provider.ts`
- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`
- `apps/web/src/components/project-settings/ComputePoolOfferingsManager.tsx`
- `apps/web/src/lib/compute-pool-offerings.ts`
- `apps/api/tests/unit/services/default-capacity-pools.test.ts`
- `apps/api/tests/unit/services/placement-resolver.test.ts`
- `apps/web/tests/playwright/default-capacity-pools-scopes-audit.spec.ts`
- `apps/web/tests/playwright/project-settings-subpages-audit.spec.ts`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/10-e2e-verification.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/47-control-loop-io-budget.md`
