# DigitalOcean/Vultr pagination silently truncates on cap exhaustion

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
