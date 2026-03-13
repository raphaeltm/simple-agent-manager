# Provider-Agnostic Instance Catalog & Location Selection

## Problem

The UI and shared types are hardcoded to Hetzner server types and locations. When a user configures Scaleway credentials, they see Hetzner locations in dropdowns and Hetzner-specific size descriptions. The `VMLocation` type is a string union of only Hetzner datacenter codes (`'nbg1' | 'fsn1' | 'hel1'`), making it impossible to select Scaleway zones.

The provider interface already exposes `locations` and `sizes` properties, but no API endpoint serves this data, and the UI doesn't consume it.

## Research Findings

### Current State
- **Provider interface** (`packages/providers/src/types.ts`): Already has `locations: readonly string[]` and `sizes: Record<VMSize, SizeConfig>` with `SizeConfig` containing `type`, `price`, `vcpu`, `ramGb`, `storageGb`
- **Hetzner provider**: 5 locations, 3 size configs (cx23/cx33/cx43)
- **Scaleway provider**: 8 locations, 3 size configs (DEV1-M/DEV1-XL/GP1-S)
- **Credential system**: Already supports both providers, stores provider name per credential
- **`getUserCloudProviderConfig()`**: Returns first credential found — no provider selection

### Hardcoded Locations
| File | Problem |
|------|---------|
| `packages/shared/src/types.ts:608` | `VMLocation = 'nbg1' \| 'fsn1' \| 'hel1'` — Hetzner only |
| `packages/shared/src/constants.ts:6-10` | `VM_SIZE_CONFIG` uses `hetznerType` field name |
| `packages/shared/src/constants.ts:15-19` | `VM_LOCATIONS` only has 3 Hetzner locations |
| `packages/shared/src/constants.ts:46` | `DEFAULT_VM_LOCATION = 'nbg1'` — Hetzner default |
| `apps/web/src/pages/CreateWorkspace.tsx:71-81` | Hardcoded Hetzner VM_SIZES and VM_LOCATIONS arrays |
| `apps/web/src/pages/ProjectSettings.tsx:16-20` | Hardcoded VM size descriptions (Hetzner specs) |
| `apps/api/src/routes/tasks/run.ts:153` | Hardcoded `'nbg1'` default |
| `apps/api/src/db/schema.ts` | `vmLocation` defaults to `'nbg1'` |

### Key Files to Modify
1. `packages/shared/src/types.ts` — Widen `VMLocation` to `string`, add provider catalog types
2. `packages/shared/src/constants.ts` — Remove Hetzner-specific constants, add provider-aware defaults
3. `packages/providers/src/types.ts` — Add location metadata (display names) to Provider interface
4. `packages/providers/src/hetzner.ts` — Add location metadata
5. `packages/providers/src/scaleway.ts` — Add location metadata
6. `apps/api/src/routes/` — Add `GET /api/providers/catalog` endpoint
7. `apps/api/src/services/provider-credentials.ts` — Support provider selection when user has multiple
8. `apps/web/src/pages/CreateWorkspace.tsx` — Fetch catalog from API, dynamic dropdowns
9. `apps/web/src/pages/ProjectSettings.tsx` — Dynamic VM size descriptions
10. `apps/api/src/routes/tasks/run.ts` — Use proper defaults
11. `apps/api/src/routes/tasks/submit.ts` — Provider-aware defaults

## Implementation Checklist

### 1. Shared Types & Constants
- [ ] Widen `VMLocation` type to `string` (provider locations are too varied for a union)
- [ ] Add `ProviderCatalog` type: `{ provider: CredentialProvider; locations: LocationInfo[]; sizes: Record<VMSize, SizeConfig> }`
- [ ] Add `LocationInfo` type: `{ id: string; name: string; country: string }`
- [ ] Remove `hetznerType` from `VM_SIZE_CONFIG` or deprecate; add provider-agnostic version
- [ ] Update `DEFAULT_VM_LOCATION` handling — make it per-provider or remove
- [ ] Subsume existing backlog tasks (fix-hardcoded-provider-defaults, fix-hardcoded-vm-location-in-run-ts)

### 2. Provider Interface & Implementations
- [ ] Add `locationMetadata` to Provider interface: `Record<string, { name: string; country: string }>`
- [ ] Implement in HetznerProvider with display names for all 5 locations
- [ ] Implement in ScalewayProvider with display names for all 8 locations
- [ ] Export `SizeConfig` type from providers package

### 3. API Endpoint
- [ ] Add `GET /api/providers/catalog` route that:
  - Looks up user's cloud provider credentials
  - Instantiates the provider(s)
  - Returns `{ provider, locations, sizes }` for each configured provider
- [ ] Handle case where user has no credentials (return empty array)
- [ ] Handle case where user has multiple providers (return array of catalogs)

### 4. UI: CreateWorkspace
- [ ] Fetch provider catalog on mount via `GET /api/providers/catalog`
- [ ] If user has one provider: show that provider's locations and sizes
- [ ] If user has multiple providers: show provider selector dropdown
- [ ] Dynamic location dropdown from catalog data
- [ ] Dynamic size selector with provider-specific specs (CPU, RAM, price)
- [ ] Show provider name in size descriptions
- [ ] Handle loading/error states

### 5. UI: ProjectSettings
- [ ] Fetch provider catalog for VM size descriptions
- [ ] Show provider-specific specs instead of hardcoded descriptions

### 6. API: Fix Hardcoded Defaults
- [ ] `apps/api/src/routes/tasks/run.ts`: Replace `'nbg1'` with `DEFAULT_VM_LOCATION`
- [ ] Ensure all location defaults are provider-aware or at least use constants

### 7. Tests
- [ ] Unit tests for provider catalog endpoint
- [ ] Unit tests for new provider metadata methods
- [ ] UI tests for dynamic dropdowns (render with catalog data)
- [ ] Integration test: catalog endpoint returns correct data for each provider type

### 8. Documentation
- [ ] Update CLAUDE.md if any architectural patterns change
- [ ] Update API reference if new endpoints added

## Acceptance Criteria

- [ ] User with Scaleway credentials sees Scaleway locations and sizes in workspace creation
- [ ] User with Hetzner credentials sees Hetzner locations and sizes
- [ ] User with both providers can select which provider to use
- [ ] VM size descriptions show accurate specs per provider
- [ ] No Hetzner-specific strings remain hardcoded in the UI
- [ ] `VMLocation` type accepts any provider's location strings
- [ ] Existing Hetzner workflows continue to work unchanged
- [ ] All existing tests pass

## References

- Subsumes: `tasks/backlog/2026-03-13-fix-hardcoded-provider-defaults.md`
- Subsumes: `tasks/backlog/2026-03-13-fix-hardcoded-vm-location-in-run-ts.md`
- Provider interface: `packages/providers/src/types.ts`
- Credential service: `apps/api/src/services/provider-credentials.ts`
