# Scaleway UI Credential Input (Phase 3)

**Created**: 2026-03-13
**Context**: Phase 3 of 3 for Scaleway provider support. Phase 1 (API generalization, PR #363) and Phase 2 (ScalewayProvider class, PR #366) are merged.

## Problem

The Settings UI only renders a Hetzner credential form. With Scaleway now a fully supported provider (types, API routes, provider class all in place), users need a UI to enter their Scaleway credentials (secret key + project ID).

## Research Findings

### Key Files
- `apps/web/src/pages/SettingsCloudProvider.tsx` — currently only renders HetznerTokenForm
- `apps/web/src/components/HetznerTokenForm.tsx` — reference implementation (137 lines)
- `apps/web/src/pages/Settings.tsx` — settings shell with tabs
- `apps/web/src/pages/SettingsContext.tsx` — provides credentials via context
- `apps/web/src/lib/api.ts` — `createCredential()`, `deleteCredential()`, `listCredentials()`
- `packages/shared/src/types.ts` — `CreateCredentialRequest` already has Scaleway discriminant
- `apps/api/src/routes/credentials.ts` — has "not yet available" guard to remove

### Existing Patterns
- HetznerTokenForm: two modes (connected vs form), password input, helper link, toast notifications
- API calls: `createCredential({ provider: 'scaleway', secretKey, projectId })` shape already defined
- `deleteCredential('scaleway')` works with existing route

### Backend Status
- `CreateCredentialRequest` union already includes `{ provider: 'scaleway'; secretKey: string; projectId: string }`
- Credential serialization/deserialization handles Scaleway
- ScalewayProvider.validateToken() works
- "Not yet available" guard in credentials.ts needs removal

## Implementation Checklist

- [ ] Remove "not yet available" error guard for Scaleway in `apps/api/src/routes/credentials.ts`
- [ ] Create `apps/web/src/components/ScalewayCredentialForm.tsx` following HetznerTokenForm pattern
  - Two fields: Secret Key (password) + Project ID (text)
  - Connected/form modes
  - Helper link to Scaleway console
  - Uses `createCredential({ provider: 'scaleway', secretKey, projectId })`
  - Uses `deleteCredential('scaleway')`
- [ ] Update `apps/web/src/pages/SettingsCloudProvider.tsx` to render both provider forms
- [ ] Write tests for ScalewayCredentialForm
- [ ] Update SettingsCloudProvider tests
- [ ] Run quality checks (lint, typecheck, test)

## Acceptance Criteria

- [ ] Users can enter Scaleway secret key and project ID in Settings
- [ ] Credentials are validated against Scaleway API before saving
- [ ] Connected state shows with date and Update/Disconnect buttons
- [ ] Both Hetzner and Scaleway forms render on the Cloud Provider settings page
- [ ] All existing tests continue to pass
- [ ] New tests cover Scaleway form submit/delete/error flows
