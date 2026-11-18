# Compute pool editor redesign: rows of provider × machine × region, nothing added on its own

## Problem

Raphaël found machines and GCP regions in his pool that he never chose, after he had cut GCP down
to a couple of European regions. Three causes, all in production on 2026-11-09:

1. **New pool rows switch themselves on.** `initialStatusForProviderOffering`
   (`apps/api/src/services/default-capacity-pool-candidates-values.ts`) activates a brand-new row
   when the offering maps to a legacy `small`/`medium`/`large` size, or when the pool still has an
   active abstract legacy row for that size (`legacyStatusForOffering`). Every catalog refresh that
   adds a zone or region, every newly connected provider, and every replaced credential therefore
   re-adds machines nobody picked.
2. **Disconnected or replaced connections stay in the editor.** When a seed disappears,
   `disableCapacitySourcesMissingFromSeeds` marks the source `disabled` and keeps it, because
   running work can still reference its ids. The editor still lists it, so the pool showed two GCP
   "accounts" (one of them the orphan from a 2026-11-05 attachment).
3. **The editor is organised per machine type with region chips**, prices are per machine, legacy
   size rows leak in, and accounts cannot be switched off.

Raphaël approved a prototype (artifact `BLxnvbCWtMM4KBcRzjsc5c`, v3) and these decisions:

- Selecting a region selects all of its zones under the hood. Users do not care about zones.
- One row per provider × machine × region, ordered provider → machine → region by default, with
  easy filtering and re-sorting. Users add rows from that list.
- Prices per machine × region, in each provider's own currency. No conversion.
- Old sizes are ignored on the catalog side. Tasks and profiles that ask for `small`/`medium`/
  `large` keep meaning the predefined vCPU/memory/disk (`DEFAULT_LEGACY_VM_SIZE_WORKLOAD_REQUIREMENTS`).
- Adding a provider does not add it to the pool. An empty pool can run only Instant sessions, and
  the editor warns about Instant's limits.
- Accounts can be switched on or off per pool. Off keeps the account's picks, on restores them.
  Disconnected or disabled accounts disappear from the pool on their own.
- Keep the per-pool account priority order (#2596).
- Do NOT edit production D1 by hand. The new editor is the fix.

## Research Findings

- **Editor today** (`apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`,
  `components/compute-pool/ComputePoolEditor.tsx`, `MachinePicker.tsx`, `ProviderOrderField.tsx`,
  `lib/compute-pool-machines.ts`, `lib/compute-pool-source-order.ts`): mounted on project, user and
  admin infrastructure settings. TanStack Query, one PATCH per save, 409 on a concurrent edit.
  `buildMachineGroups` builds source → machine type → per-location cells from candidates + catalog.
- **PATCH** (`services/default-capacity-pool-updates.ts`): candidate edits + policy are one fenced
  D1 batch that bumps `revision`. A provider-order-only edit does NOT bump the revision, because
  node reuse authority (`placement-authority.ts`) requires a node's recorded pool revision; it is
  CAS-fenced on the stored order instead (`publishSourceOrderOnly`).
- **Sources are per scope/owner**, linked to the pool only through candidate rows. Placement needs
  pool, source and candidate all `active` (`placement-resolver-capacity.ts`
  `isActiveCapacityPlacementOption`, `placement-authority.ts` reuse SQL).
- **Source status writers**: `insertCapacitySourceForSeed` (active), `updateCapacitySourceForSeed`
  (re-activates unless deleted), `disableCapacitySourceAvailability`, GCP mirror retirement. Status
  is lifecycle health, so a person's on/off must be stored separately (rule 74: one signal per
  condition).
- **Zones**: candidates store only `location` (the GCP zone). `gcpZoneRegion`
  (`packages/providers/src/gcp-catalog.ts`) is the only zone → region helper. Only 8 GCP zones
  have friendly names (`PROVIDER_LOCATIONS`, `gcp-metadata.ts` `LOCATION_METADATA`).
- **Empty pool**: an owned pool is authoritative even when empty
  (`resolveEffectiveDefaultCapacityPoolSummary`), so VM tasks fail with
  `no-eligible-capacity-candidate`. The message is jargon ("Reconcile the pool or add an active
  provider-native offering").
- **Account names**: `CapacitySourceIdentity` has no label; the UI shows
  "Google Cloud · Infrastructure settings (2)". Connections have `cc_credentials.name`.
- **Disabled sources and running work**: `nodes`/`workspaces`/`tasks.capacity_source_id` reference
  sources (`ON DELETE SET NULL`) and GCP mirror retirement keeps ids on purpose. Deleting source
  rows is not needed to take them out of the pool: placement already ignores non-active sources.
  So "removed under the hood" = never placed, hidden from the editor, out of the account list.

## Implementation Checklist

### Backend
- [x] New candidate rows start unselected: remove legacy-size and legacy-row status inheritance
      from `initialStatusForProviderOffering`; delete `legacyStatusForOffering`.
- [x] A new zone row inherits `active` only from an active row of the same source, machine type
      and REGION (region selection = all its zones, including zones the provider adds later).
- [x] Shared `providerLocationRegion(provider, location)`; `gcpZoneRegion` delegates to it.
- [x] Shared GCP and Scaleway region metadata (`providerRegionMeta`: name + country) for the
      editor's region labels. (The GCP catalog keeps its own zone names; see Deviations.)
- [x] Migration 0230: `capacity_pools.excluded_source_ids_json` (nullable, `json_valid`).
- [x] `CapacityPool.excludedSourceIds`; PATCH `excludedSourceIds?: string[] | null`; route
      validation (≤ `MAX_CAPACITY_POOL_SOURCE_ORDER_LENGTH`, unique, non-empty strings).
- [x] Update service: exclusion changes are CAS-fenced like the provider order and do not bump the
      revision; activating machines of an excluded account removes it from the exclusions in the
      same atomic edit.
- [x] Every placement reader skips excluded sources: resolver, reuse/admission authority SQL,
      summary counts / effective state, safe effective summary.
- [x] Editor summaries carry an account `label` (connection name) for sources.
- [x] Clear empty-pool placement error that names Settings → Infrastructure and Instant sessions.

### Frontend
- [x] Region rows: `buildMachineRegionRows` (provider × machine × region per source), draft keyed
      by region row; allowing a row activates every addable zone and adds missing zones.
- [x] New editor: status chip, "In your pool" pane (accounts with switches, order, picked items,
      remove, show all, Remove all, empty-pool Instant warning), "Available machines" pane (search,
      All/In pool/Not in pool, provider chips, continent chips, min vCPU, min memory, max price,
      hide sold out, sortable columns, bulk add/remove), pool settings kept, save bar.
- [x] Disabled (disconnected) sources hidden from the editor and the account list.
- [x] No small/medium/large labels in the editor.
- [x] Editor is the default view when the scope owns its pool; read-only fallback unchanged.

### Docs and tests
- [x] `apps/www/src/content/docs/docs/guides/compute-pools.md` (and self-hosting note): nothing is
      added on its own, regions, accounts on/off, empty pool = Instant only.
- [x] API tests: no auto-activation (new provider, new zone, new region, legacy rows present),
      region sibling inheritance + control, exclusions in resolver/authority/summary, CAS conflict,
      re-inclusion on add, empty-pool error message.
- [x] Web tests: region row building, draft → PATCH body, account switch, hidden disabled sources.
- [x] Playwright audit at 375 and 1280 with long names, many rows, empty pool, error.

### Deferred (tracked)
- Credential "fix permissions" replacement creates a new credential id, so its source starts with
  no picks: `tasks/backlog/2026-11-09-credential-replacement-keeps-pool-picks.md`.
- A person's edit changes the publication digest (candidate status is part of it), so the next
  refresh republishes the catalog and the pool reads pending meanwhile:
  `tasks/backlog/2026-11-09-capacity-pool-readiness-gate-during-republication.md`.

## Acceptance Criteria

- [x] A catalog refresh, a newly connected account and a replaced credential never activate a
      machine a person did not pick (zones of a picked region excepted).
- [x] Switching an account off stops placement on it (new VMs and reuse) and keeps its picks;
      switching it on restores them.
- [x] A disconnected or disabled account does not appear in the editor and is never placed.
- [x] The editor lists one row per provider × machine × region with a native-currency price.
- [x] An empty pool shows the Instant-only warning, and a VM task fails with a clear message.
- [x] Task/profile `small`/`medium`/`large` requests still resolve to the predefined resources.

## Implementation Notes and Deviations

- The shared helper is `providerLocationRegion(provider, location)` with region metadata
  `providerRegionMeta` (`packages/shared/src/constants/provider-regions.ts`); `gcpZoneRegion`
  delegates to it. The GCP catalog keeps its own zone display names; only the editor uses the
  region metadata, which is all the redesign needs.
- Disconnected or disabled accounts are not deleted. Every credential mutation route calls
  `reconcileCapacityPoolsForCredentialMutation()`, which disables the gone source
  (`disableCapacitySourcesMissingFromSeeds()`), and placement only reads active sources
  (`isActiveCapacityPlacementOption()`, the `s.status = 'active'` predicate in
  `placement-authority.ts`). The editor hides non-active sources (`connectedOnly()` in
  `DefaultCapacityPoolsPanel.tsx`). Keeping the rows preserves references held by running work,
  so no cleanup migration was needed.
- The desktop machine table puts the account under the machine name (sortable by either) so it
  fits the 740px settings pane; the Playwright audit asserts the table and its Add/Remove buttons
  fit without sideways scrolling.
- Small/medium/large requests are unchanged on the request side (`resource-requirements-input.ts`,
  covered by `resource-requirements-input.test.ts`). The catalog side no longer reads them.

## Acceptance Evidence

- No auto-activation: `default-capacity-pools.test.ts` (initial status cases, fresh pool counts 0,
  legacy rows ignored) and `capacity-pool-editor-redesign.test.ts` (region inheritance, deleted
  region not re-added).
- Account off/on: `capacity-pool-editor-redesign.test.ts` (resolver exclusion with two accounts,
  re-include on add, CAS conflict) and `placement-authority-effective-pool.test.ts` (reuse and
  admission skip a switched-off account). Both proven discriminating by removing the guard.
- Hidden disconnected accounts: `default-capacity-pools-panel.test.tsx` and
  `compute-pool-editor.test.tsx`.
- One row per provider × machine × region: `compute-pool-region-rows.test.ts`.
- Empty pool: editor warning in `compute-pool-editor.test.tsx` and the Playwright audit (account
  switched off); placement message in `capacity-pool-editor-redesign.test.ts`.

## References

- Prototype: https://claude.ai/artifact/BLxnvbCWtMM4KBcRzjsc5c
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`, `67`, `44`, `71`, `81`
- Previous PR: #2608 (publication deadline loop)

## Verification Notes

- Full suites green on the final branch: API 15,743 passed (4 skipped), web 5,073, shared 962,
  providers 804; build, `pnpm check:fast` and `pnpm quality:migration-safety` pass.
- Staging deploy (run 42675226281, commit 6fa8636) green. Staging D1: migration 0230 applied,
  the array-only CHECK present, every pool kept its picks (18 / 96 / 18 active native rows).
- Production and staging D1 had no pool whose only active rows were legacy size presets, so the
  change empties no existing pool.
- Live UI verification on staging was skipped at the user's direction (no staging login in this
  session); it is done in production after the deploy instead.
