# Provider-native compute pool catalog reconciliation

## Problem statement

PR #1943's compute-pool editor still behaves as if pool offerings are derived from SAM's legacy `small | medium | large` node-size presets. In staging, adding offerings appears limited to the old SAM-supported node types instead of the concrete provider-native instance catalog available through installation, user, or project cloud-provider credentials.

The default pool reconciliation and edit surface must use one credential-scoped provider catalog universe: every concrete provider offering available to the relevant scope can be selected, removed, and re-added. Legacy size hints may remain only as migration/backfill hints from old profiles/defaults into concrete provider instance types. They must not constrain add choices, reconciliation inventory, or user-visible pool catalog rows.

Target: existing PR #1943 / branch `sam/compute-pools-integration`. Do not merge. Deploy to staging after implementation, post evidence to PR #1943, and clean staging back to zero VMs/nodes at rest.

## Research findings

- Current PR head at Phase 1 start: `200ebbd3bd7ddcdb0b681301603900f409c53b9c`.
- `apps/api/src/routes/providers.ts` already has a live provider catalog path: `listProviderCatalogOfferings()` calls `provider.listInstanceOfferings({ preferApi: true })` and falls back to `preferApi: false` with a sanitized warning.
- `packages/providers/src/hetzner.ts` implements `listInstanceOfferings()` by fetching Hetzner `server_types` and mapping them through `packages/providers/src/hetzner-instance-offerings.ts`.
- Hetzner's official Cloud API reference documents server types as the source of offered server plans and includes hourly/monthly pricing with net and gross values. The implementation currently maps gross hourly/monthly values into EUR fields, which is the right source for live staging evidence. Reference: <https://docs.hetzner.cloud/reference/cloud>
- `apps/api/src/services/default-capacity-pool-candidates.ts:ensureCandidatesForSource()` still calls `getProviderInstanceOfferings(provider)` from `packages/providers/src/instance-offerings.ts`; that static helper maps only the legacy provider `VMSize` records.
- `ensureCandidatesForSource()` therefore cannot see API-returned Hetzner offerings beyond the curated static `small | medium | large` set, and its signature has only a provider enum rather than a credential-backed provider instance.
- `apps/api/src/services/default-capacity-pools.ts` already resolves the scope-specific credential rows for installation, user, and project default pools, but currently passes only `seed.provider` into candidate seeding. This is the right seam to carry decrypted/provider-instance catalog access without duplicating scope discovery.
- `apps/api/src/services/provider-credentials.ts` centralizes runtime provider creation and has the correct user/project/platform fallback semantics for actual provisioning. Catalog/reconciliation should reuse or extract provider construction logic rather than reimplementing token handling.
- The UI path in `apps/web/src/lib/compute-pool-offerings.ts:buildComputePoolOfferingsModel()` flattens `/api/providers/catalog`, but then filters the edit catalog down to rows that already match existing candidate IDs. Catalog-only provider offerings are dropped instead of being presented as addable.
- `apps/web/src/components/project-settings/ComputePoolOfferingsManager.tsx` already has provider, region/location, vCPU, memory, price, and availability filters. Those controls need to operate across the full provider-native add universe.
- Existing edit behavior preserves removed/deleted candidate status when reconciliation updates candidate metadata. That must remain true: later reconciliation may refresh metadata and disable no-longer-available active rows, but it must not silently reactivate user removals.
- Prior compute-pool architecture knowledge says candidates must be keyed by credential/source, provider, location/region, and provider-native instance type/SKU, with normalized resource/price metadata where available; legacy `small | medium | large` must not be candidate identity.
- Prior repair post-mortem (`tasks/active/2026-08-28-repair-compute-pool-default-editing.md`) says the previous bug came from treating generated pool data as system-owned and not testing the edit workflow visually. This task must test the actual edit/add/remove flow, not only read-only rendering.
- Staging capacity policy is strict: Hetzner capacity is shared and staging must return to zero VMs/nodes at rest. Validation must clean up any workspace/node/VM it creates and verify cleanup with D1/provider evidence.
- Relevant rules/docs read during research: `.claude/rules/09-task-tracking.md`, `.claude/rules/13-staging-verification.md`, `.claude/rules/14-do-workflow-persistence.md`, `.claude/rules/17-ui-visual-testing.md`, `.claude/rules/25-review-merge-gate.md`, `.claude/rules/28-credential-resolution-fallback-tests.md`, `.claude/rules/32-cf-api-debugging.md`, `.claude/rules/33-staging-feature-validation.md`, `.claude/rules/35-vertical-slice-testing.md`, `.claude/rules/47-control-loop-io-budget.md`, `.claude/rules/31-migration-safety.md`, `.claude/skills/api-reference/SKILL.md`, `specs/028-provider-infrastructure/*`, and `apps/www/src/content/docs/docs/architecture/overview.md`.

## Implementation checklist

- [x] Extract or add a scope-aware provider catalog service that can build non-secret `ProviderCatalog` results for installation/platform, user, and project compute credentials using credential-backed provider instances.
- [x] Share the live provider offering fetch/normalization path used by `/api/providers/catalog`, including sanitized API-failure logging and static fallback with `catalogSource: static`.
- [x] Update `/api/providers/catalog` to use the shared catalog service and include the catalogs relevant to the authenticated editing context without leaking tokens.
- [x] Extend `ensureCandidatesForSource()` / default pool reconciliation so each active capacity source seeds from the credential-backed provider-native offering catalog, not `getProviderInstanceOfferings(provider)`.
- [x] Preserve user-disabled/user-deleted candidate status on reconciliation while refreshing metadata for existing rows and disabling only active rows that disappear from the provider catalog.
- [x] Keep legacy size hints only as best-effort internal metadata for old profile/default migration/backfill; never expose `small | medium | large` as add choices.
- [x] Ensure project, user, and installation default pools each resolve all compute credentials available at that scope and seed/edit against the same provider-native universe.
- [x] Adjust the web compute-pool offerings model so the edit catalog includes provider-native API offerings beyond currently active candidates and keeps removed offerings addable again.
- [x] Verify add filters work across full catalog metadata: provider, region/location, vCPU, RAM, price, availability/catalog source.
- [x] Add API/service tests proving Hetzner reconciliation uses API-returned offerings beyond legacy static sizes and persists live EUR price/resource metadata with `catalogSource: api`.
- [x] Add tests proving live provider API failure falls back per-provider to static offerings and marks `catalogSource: static`.
- [x] Add route/service tests for installation, user, and project scope credential catalogs and no secret leakage.
- [x] Add web unit/interaction tests proving API catalog offerings not currently active are visible in add flow, removed offerings can be added back, and `small | medium | large` do not appear as add choices.
- [x] Refresh Playwright desktop/mobile screenshots for compute-pool read/edit/add/filter states with more than the old three instance types.
- [x] Run local targeted tests for provider catalog, default capacity-pool reconciliation, API routes, and UI add/remove/filter behavior.
- [ ] Run full pre-PR validation: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- [ ] Run required specialist reviews and address/document every actionable finding.
- [ ] Deploy `sam/compute-pools-integration` to staging and verify the live Hetzner pool add list uses API catalog entries beyond old defaults, with `catalogSource=api` and EUR price metadata.
- [ ] Run a real staging prompt/session that provisions through the effective compute-pool path, then clean up staging workspaces/nodes/VMs and confirm zero VMs/nodes at rest.
- [ ] Post PR #1943 comments with screenshot evidence, staging/catalog/D1/log evidence, real VM prompt/session evidence, cleanup confirmation, head SHA, staging URL, and validation summary.
- [ ] Trigger CodeRabbit by `coderabbit-review` label only and address/document any new actionable review items.

## Acceptance criteria

- Editing a compute pool presents the full provider-native offering catalog available to that pool's credential scope, not only old SAM node-size presets.
- Installation pools use enabled installation/platform compute credentials; user pools use active personal compute credentials; project pools use active project-accessible compute credentials.
- Reconciliation/default-pool creation seeds concrete provider-native offerings from the same universe used by the editor.
- Hetzner uses live API `server_types` and live gross EUR pricing when credentials/API are available; static fallback is used only for provider API failure and is reflected as `catalogSource: static`.
- Removed offerings stay removed across reconciliation and can be re-added if still present in the full provider catalog.
- No user-visible add choice is `small`, `medium`, or `large`.
- Add filters work across provider, region/location, vCPU, memory, price, and availability/catalog metadata with >3 concrete offerings.
- Automated tests cover service/reconciliation, provider catalog routes, scope resolution, no secret leakage, and web add/remove/filter behavior.
- Desktop and mobile Playwright screenshots are captured, reviewed, and posted to PR #1943.
- Staging deploy succeeds for the target branch, live API/D1 evidence shows `catalogSource=api` and EUR price fields for Hetzner, a real VM-backed prompt/session exercises the effective pool path, and staging is cleaned back to zero VMs/nodes at rest.
- PR #1943 remains draft/open and unmerged.

## References

- PR #1943: <https://github.com/raphaeltm/simple-agent-manager/pull/1943>
- `apps/api/src/routes/providers.ts`
- `apps/api/src/services/default-capacity-pool-candidates.ts`
- `apps/api/src/services/default-capacity-pools.ts`
- `apps/api/src/services/provider-credentials.ts`
- `packages/providers/src/hetzner.ts`
- `packages/providers/src/hetzner-instance-offerings.ts`
- `packages/providers/src/instance-offerings.ts`
- `apps/web/src/lib/compute-pool-offerings.ts`
- `apps/web/src/components/project-settings/ComputePoolOfferingsManager.tsx`
- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`
- `apps/api/tests/unit/services/default-capacity-pools.test.ts`
- `apps/api/tests/unit/routes/providers.test.ts`
- `apps/api/tests/unit/routes/capacity-pools-defaults.test.ts`
- `apps/api/tests/unit/routes/project-capacity-pools.test.ts`
- `apps/web/tests/unit/lib/compute-pool-offerings.test.ts`
- `apps/web/tests/unit/components/default-capacity-pools-panel.test.tsx`
- `apps/web/tests/playwright/default-capacity-pools-scopes-audit.spec.ts`
- Hetzner Cloud API reference: <https://docs.hetzner.cloud/reference/cloud>
