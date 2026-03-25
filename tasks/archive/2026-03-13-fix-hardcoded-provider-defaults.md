# Fix Hardcoded Provider Defaults (Constitution XI)

## Problem

Constitution audit found three pre-existing Principle XI violations in the providers package:

1. **HIGH**: `packages/providers/src/hetzner.ts:115` — hardcoded `'ubuntu-24.04'` instead of using `DEFAULT_HETZNER_IMAGE` from shared constants
2. **MEDIUM**: `packages/providers/src/hetzner.ts:75` — hardcoded `'fsn1'` datacenter fallback with no constant or env var
3. **MEDIUM**: `packages/shared/src/types.ts:603` — `VMLocation` type only includes Hetzner locations, needs Scaleway zones

## Resolution

Already fixed in the current codebase:
- `hetzner.ts:127` uses `DEFAULT_HETZNER_IMAGE` (not hardcoded `'ubuntu-24.04'`)
- `hetzner.ts:86` uses `DEFAULT_HETZNER_DATACENTER` (not hardcoded `'fsn1'`)
- `constants.ts:292-295` defines both `DEFAULT_HETZNER_DATACENTER` and `DEFAULT_HETZNER_IMAGE`
- `VM_LOCATIONS` map in constants.ts includes Hetzner, Scaleway, and GCP locations

## Acceptance Criteria

- [x] Replace `'ubuntu-24.04'` literal in hetzner.ts with `DEFAULT_HETZNER_IMAGE` import
- [x] Verify `nodes.ts` passes `env.HETZNER_IMAGE` into VMConfig.image
- [x] Add `DEFAULT_HETZNER_DATACENTER` constant to shared/constants.ts
- [x] Use `DEFAULT_HETZNER_DATACENTER` in hetzner.ts constructor
- [x] Expand `VMLocation` type to include Scaleway zones (or widen to string)
- [x] Update `VM_LOCATIONS` map to cover all provider locations
- [x] Reconcile `DEFAULT_VM_LOCATION` ('nbg1') with datacenter default ('fsn1')

## Context

Discovered during constitution review of the multi-provider generalization PR. These are pre-existing issues, not introduced by that PR.
