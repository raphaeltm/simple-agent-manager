# DigitalOcean/Vultr pagination silently truncates on cap exhaustion

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the Hetzner half of the Principle XI item. `maxListPages` is a runtime option
>   and `HETZNER_MAX_LIST_PAGES` is wired (`packages/providers/src/hetzner.ts:115`,
>   `hetzner-metadata.ts:114`, `apps/api/src/services/provider-credential-codecs.ts:162`,
>   `apps/api/src/env.ts:563`; commit 6270514b6).
> - **Still open:**
>   - DigitalOcean still warns and returns a partial list on cap exhaustion
>     (`packages/providers/src/digitalocean.ts:333`, `digitalocean-volumes.ts:318`).
>   - Vultr still truncates (`vultr.ts:346,375`); `vultr-volumes.ts:282-296` truncates without
>     even a warning.
>   - The GCP page cap is not configurable (`gcp.ts:736`, no `GCP_MAX_LIST_PAGES`), and Vultr's
>     cap is a fixed constant (`VULTR_MAX_LIST_PAGES = 50`).
>   - Regression tests asserting the throw and the call count.

## Problem

PR #1744 fixed Hetzner and GCP pagination to throw `ProviderError` when the
max-page guard is exhausted. DigitalOcean and Vultr still **silently truncate**:
they `logger.warn` and return whatever has been collected so far instead of
throwing.

This means a fleet larger than `maxListPages × perPage` silently loses the
tail entries from `listVMs` / `listVolumes`, which can cause:

- Nodes/volumes not shown in the UI
- Cleanup sweeps that never see the oldest resources
- Billing/quota calculations that under-count

## Where

- `packages/providers/src/digitalocean.ts` — `fetchAllDroplets` (line ~355):
  loop ends at `this.maxListPages` and returns without error.
- `packages/providers/src/vultr.ts` — similar pattern in paginated list
  helpers.

## Acceptance Criteria

- [ ] DigitalOcean `fetchAllDroplets` and volume list throw `ProviderError`
      with `category: 'invalid_config'` when the page cap is exhausted, matching
      the Hetzner/GCP pattern.
- [ ] Vultr list helpers throw `ProviderError` on cap exhaustion.
- [ ] Regression tests assert the throw and verify call count equals the cap.

## Also: Hetzner/GCP max-list-pages not constructor-overridable (Principle XI)

`DEFAULT_HETZNER_MAX_LIST_PAGES` and `DEFAULT_GCP_MAX_LIST_PAGES` are exported
constants but not wirable through the constructor or env vars, unlike
DigitalOcean which has `maxListPages` in its config + `DIGITALOCEAN_MAX_LIST_PAGES`
env var. The `DEFAULT_*` naming implies an override path should exist.

- [ ] Add `maxListPages?: number` to `HetznerProviderRuntimeOptions` and
      `GcpProviderConfig`, defaulting to the `DEFAULT_*` constants.
- [ ] Thread through `createProvider()` in `index.ts`.
- [ ] Add `HETZNER_MAX_LIST_PAGES` / `GCP_MAX_LIST_PAGES` env vars in
      `env.ts` + `provider-credentials.ts`.

