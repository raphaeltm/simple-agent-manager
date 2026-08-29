# Provider-native compute pool UI

## Problem

Compute pool management is currently mixed into credential pages and presents pool candidates as abstract small/medium/large checkboxes. Raphaël explicitly wants credentials pages to stay focused on connecting provider access, while compute pools live under Infrastructure settings and define concrete infrastructure resources.

Rewrite the installation, user, and project compute-pool surfaces so users manage allowed provider-native instance offerings by provider, region/location, and instance type/SKU. V1 may still operate on one effective/default pool per scope, but the UX and frontend types should not block later multiple pools.

## Constraints

- Target the existing integration PR branch `sam/compute-pools-integration`.
- Do not deploy to staging.
- Do not merge.
- Push completed implementation to `sam/compute-pools-integration`.
- Preserve v1 precedence: project default pool → user default pool → installation default pool.
- Do not duplicate scheduler/placement decision logic.
- Do not include unrelated `.codex/config.toml` changes.
- UI evidence must include Playwright desktop and mobile screenshots with stress mock data and explicit QC review.

## Research findings

- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx` is the shared compute-pool panel for project, user, and installation scopes. It currently groups candidates by provider/location/runtime/class and renders machine-size pills plus edit checkboxes. This finding maps to the checklist items for replacing the panel display/editor with provider-native offering rows/cards and add/remove actions.
- `apps/web/src/pages/ProjectSettings.tsx` already exposes project compute pools under the Project Settings → Infrastructure tab. This should remain the project-level canonical surface and be updated in place.
- `apps/web/src/pages/SettingsCloudProvider.tsx` imports `DefaultCapacityPoolsPanel scope="user"`, so user pools currently appear on the Cloud Provider credential page. This finding maps to adding a user Infrastructure route/tab and removing the pool panel from the credential page.
- `apps/web/src/pages/AdminPlatformCredentials.tsx` imports `DefaultCapacityPoolsPanel scope="installation"`, so installation pools currently appear on the Admin Credentials page. This finding maps to adding an Admin Infrastructure route/tab and removing the pool panel from the credential page.
- `apps/web/src/App.tsx`, `apps/web/src/pages/Settings.tsx`, and `apps/web/src/pages/Admin.tsx` define settings/admin routing and tabs. They need route/tab updates for the new user and installation Infrastructure pages.
- `packages/shared/src/types/capacity-pool.ts` now exposes provider-native candidate metadata fields including provider instance type/SKU, display name, vCPU, RAM, disk, price, catalog source, and catalog last-seen timestamps. `machineSize` remains only as a legacy compatibility/grouping hint.
- `packages/shared/src/types/provider.ts` and `apps/api/src/routes/providers.ts` now expose provider-native `offerings[]` alongside legacy locations/sizes compatibility fields. Catalog rows include credential/source identity, region/location, provider instance type/SKU, normalized resource metadata, price/currency when known, and catalog source.
- The backend defaults service now seeds candidate rows from provider-native offering catalogs for the available installation/user/project credentials and preserves explicit user removals across reconciliation. The remaining UI seam is arbitrary add of API-only catalog rows that do not yet have a reconciled candidate row; the UI adapter should keep those hidden or disabled until a backend mutation contract creates candidate rows on demand.
- `apps/web/src/hooks/useProviderCatalog.ts` already uses TanStack Query and query-scope isolation for catalog fetches. New compute-pool catalog consumption should reuse this hook and a typed adapter rather than adding a parallel loader.
- `apps/web/src/lib/api/capacity-pools.ts` PATCH clients currently send `DefaultCapacityPoolUpdateRequest` with policy changes and candidate status updates by candidate ID. UI inputs that change allowed offerings must propagate into this request body and be covered by unit tests.
- `apps/web/tests/unit/components/default-capacity-pools-panel.test.tsx` currently asserts small/medium/large display/edit behavior and scope-specific API routing. These tests need to assert provider-native SKU/spec display, add/remove payloads, blocked credential setup states, and no secret leakage.
- `apps/web/tests/playwright/default-capacity-pools-scopes-audit.spec.ts` currently visits `/settings/cloud-provider` and `/admin/credentials` and removes “Small”/“Medium” candidates. This must move to user/admin Infrastructure URLs and use stress catalog data.
- `apps/web/tests/playwright/project-settings-subpages-audit.spec.ts` covers the project Infrastructure tab and default pool edit flow. Its compute-pool assertions and screenshots need to switch from t-shirt-size candidate removals to provider-native offering add/remove with stress catalog data.
- `tasks/active/2026-08-28-repair-compute-pool-default-editing.md` documents the existing default-pool editing repair and confirms hidden scope placeholders must not render, reconciliation must not undo user-removed candidates, and desktop/mobile screenshots are required per changed surface.
- `tasks/archive/2026-08-28-per-surface-ui-screenshot-evidence.md` documents the PR gate requiring `UI Screenshot Evidence` to enumerate each changed surface with desktop and mobile links, stress data, and QC attestation.
- `.claude/rules/24-no-duplicate-ui-controls.md` applies: moving pool controls off credentials pages must remove the old controls, not add duplicate controls.
- `.claude/rules/48-stale-while-revalidate-ui.md` applies: new/modified data surfaces should use TanStack Query and avoid unmounting existing content during background refetch.
- `.claude/rules/06-technical-patterns.md` applies: every new UI control must be traced through the API request body, and handlers must be checked against local `useEffect` dependencies.
- `.claude/rules/17-ui-visual-testing.md` and `.claude/rules/04-ui-standards.md` require mobile-first UI validation with Playwright screenshots at 375×667 and 1280×800, no horizontal overflow, long text, many items, empty/error states, and screenshot QC review.
- Stored project knowledge says Raphaël primarily uses the mobile PWA and often catches horizontal scrolling, so the picker/editor must be mobile-first and explicitly overflow-tested.
- Stored compute-pool architecture knowledge says credentials authorize capacity sources, compute pools define scoped eligibility/ranking, v1 uses only one effective pool per run, and placement resolution must remain centralized.

## UI variants considered

1. Inline table/card editor inside the existing default-pool panel, with an “Allowed instances” section and a filterable “Add instances from catalog” section.
2. Dedicated full-page pool builder for each scope, replacing the compact panel with a two-column desktop layout and a single-column mobile layout.
3. Modal or drawer picker launched from the existing panel.

Selected direction: variant 1 for this PR. It keeps the existing query/mutation wiring and scope reuse, minimizes routing churn, works on mobile as a single-column flow, and still expresses the future multiple-pool model through copy and data structures without shipping a second canonical editor.

## Implementation checklist

- [x] Add/adjust shared frontend types and an isolated adapter that normalizes current and future provider-native catalog shapes into `ComputePoolOffering` rows containing provider, region, SKU/type, vCPU, RAM, disk, price, availability/staleness, and matching candidate IDs when present.
- [x] Move user compute-pool management from Settings → Cloud Provider to a new Settings → Infrastructure route/tab, leaving credential setup forms on the Cloud Provider page.
- [x] Move installation compute-pool management from Admin → Credentials to a new Admin → Infrastructure route/tab, leaving platform credential management on Admin → Credentials.
- [x] Keep project compute-pool management on Project Settings → Infrastructure and update it in place.
- [x] Implement scope-aware empty/blocked states that explain the required credential scope and link users to the relevant setup page: user cloud credentials, project-shared cloud credentials, or admin platform cloud credentials.
- [x] Replace read-only candidate pills with allowed instance rows/cards showing provider, region/location, concrete SKU/type, vCPU, RAM, disk, price when known, runtime/class/status, and remove/restore actions.
- [x] Replace checkbox/t-shirt-size editor with provider-native add/remove controls. Removed offerings must disappear from the active allowed list and appear as removed/restorable, not as unchecked small/medium/large pills.
- [x] Add a fast catalog picker with filters for provider, region/location, minimum vCPU, minimum memory, and maximum price where parseable/available.
- [x] Add bulk-friendly affordances for filtered catalog results and selected allowed offerings, while preserving scope-specific PATCH requests through the existing API clients.
- [x] Ensure add/remove UI state propagates into `DefaultCapacityPoolUpdateRequest.candidates` and route-specific API clients for project/user/installation scopes.
- [x] Update component/unit tests for provider-native offering display, add/remove payloads, blocked credential states, user/admin/project route placement, and no secret text leakage.
- [x] Update Playwright audits for project, user, and installation pool pages on desktop and mobile with stress data: many providers, 30+ offerings, long instance names, multiple regions, missing price, high price, unavailable/stale offerings, special characters, and a small mobile viewport.
- [x] Run Playwright screenshot capture into `.codex/tmp/playwright-screenshots/`, review screenshots for overflow/clipping/readability, and record screenshot artifact paths/QC results.
- [x] Run focused and repo-level validation for task-owned changes before specialist review.

## Acceptance criteria

- Compute-pool management is no longer rendered on user/provider credential pages or admin credential pages.
- Installation, user, and project compute-pool surfaces are available under Infrastructure pages/settings.
- When no relevant provider credentials exist, each pool surface guides to credential setup at the correct scope.
- Project-level copy clearly states that project compute credentials are set up by a user but granted/shared for project access.
- No compute-pool UI asks users to choose `small`, `medium`, or `large` as pool candidates.
- Allowed pool entries and catalog picker entries show concrete provider-native SKU/type, vCPU, RAM, disk when known, price when known, provider, and region.
- Users can remove allowed offerings and the removed offering no longer appears as active/allowed.
- Users can add/restored catalog offerings where the current backend candidate row exists; backend-native arbitrary offering creation remains isolated behind the adapter until that backend API lands.
- Catalog picker filters by provider, region/location, vCPU, memory, and price where price can be parsed.
- Add/remove interactions send candidate status updates through the correct project/user/installation API client.
- UI tests and Playwright audits cover project, user, and installation surfaces with stress data and no horizontal overflow.
- Desktop and mobile Playwright screenshot artifacts are captured and QC-reviewed for every changed surface.
- No staging deployment is performed and the PR remains unmerged.

## UI Screenshot Evidence

Playwright generated all screenshots under `.codex/tmp/playwright-screenshots/` from stress mocks with 36 candidate rows, many provider catalogs, long provider-native SKU/location strings, multiple regions, missing prices, high prices, unavailable/stale offerings, special characters, and the 375×667 mobile viewport. The directory is intentionally gitignored; these exact artifact paths were recorded for PR handoff.

User Infrastructure:

- `.codex/tmp/playwright-screenshots/default-capacity-pools-user-section-desktop-1280x800--1280x800.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-user-section-iphone-se-375x667--375x667.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-user-edit-desktop-1280x800--catalog-results-1280x800.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-user-edit-iphone-se-375x667--catalog-results-375x667.png`

Installation Infrastructure:

- `.codex/tmp/playwright-screenshots/default-capacity-pools-installation-section-desktop-1280x800--1280x800.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-installation-section-iphone-se-375x667--375x667.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-installation-edit-desktop-1280x800--catalog-results-1280x800.png`
- `.codex/tmp/playwright-screenshots/default-capacity-pools-installation-edit-iphone-se-375x667--catalog-results-375x667.png`

Project Infrastructure:

- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-normal-section-1280x800.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-normal-section-375x667.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-empty-section-1280x800.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-empty-section-375x667.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-many-section-1280x800.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-many-section-375x667.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-edit-catalog-results-focused-1280x800.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-edit-catalog-results-focused-375x667.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-edit-removed-focused-1280x800.png`
- `.codex/tmp/playwright-screenshots/project-settings-default-compute-pool-edit-removed-focused-375x667.png`

QC result: manually reviewed representative desktop and mobile screenshots for all three scopes. The compute-pool sections show concrete SKU/provider/region/spec/price data, removed offerings move out of the active allowed list into removed/restorable cards, catalog filters and bulk actions remain readable on mobile, long strings wrap, and no compute-pool horizontal overflow or clipping was observed. The only clipped-overflow advisory emitted by the Playwright run was on the unrelated project Access settings page.

## References

- User request in SAM task `01M159NJYQMMXHDZE23A96DMFD`
- Draft integration PR: https://github.com/raphaeltm/simple-agent-manager/pull/1943
- `apps/web/src/components/project-settings/DefaultCapacityPoolsPanel.tsx`
- `apps/web/src/pages/ProjectSettings.tsx`
- `apps/web/src/pages/Settings.tsx`
- `apps/web/src/pages/SettingsCloudProvider.tsx`
- `apps/web/src/pages/Admin.tsx`
- `apps/web/src/pages/AdminPlatformCredentials.tsx`
- `apps/web/src/hooks/useProviderCatalog.ts`
- `apps/web/src/lib/api/capacity-pools.ts`
- `apps/web/src/lib/query-options/capacity-pools.ts`
- `packages/shared/src/types/capacity-pool.ts`
- `packages/shared/src/types/provider.ts`
- `apps/api/src/routes/providers.ts`
- `apps/api/src/services/default-capacity-pools.ts`
- `apps/api/src/services/default-capacity-pool-updates.ts`
- `apps/web/tests/unit/components/default-capacity-pools-panel.test.tsx`
- `apps/web/tests/playwright/default-capacity-pools-scopes-audit.spec.ts`
- `apps/web/tests/playwright/project-settings-subpages-audit.spec.ts`
- `tasks/active/2026-08-28-repair-compute-pool-default-editing.md`
- `tasks/archive/2026-08-28-per-surface-ui-screenshot-evidence.md`
- `specs/028-provider-infrastructure/spec.md`
- `apps/www/src/content/docs/docs/guides/creating-workspaces.md`
- `.claude/rules/06-technical-patterns.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/24-no-duplicate-ui-controls.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `.claude/rules/48-stale-while-revalidate-ui.md`
