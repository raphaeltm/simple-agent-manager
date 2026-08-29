# PR #1943 screenshot evidence — head `200ebbd3`

Captured for `sam/compute-pools-integration` at head `200ebbd3bd7ddcdb0b681301603900f409c53b9c`.

Command:

```bash
pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/default-capacity-pools-scopes-audit.spec.ts tests/playwright/project-settings-subpages-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)" -g "Default capacity pool|Infrastructure sub-page"
```

Result: 6 passed.

Stress data used by the mocks covers many providers, long owner/source/SKU strings, many regions, missing price, high price, stale/unavailable offerings, catalog filter interactions, and 375x667 mobile viewport.

Manual QC result: PASS. Compute-pool management is under Settings/Admin/Project Infrastructure, provider credentials remain separate, concrete provider-native offerings render with stress metadata, desktop/mobile filter controls fit, and no horizontal overflow or clipped primary actions were observed.
