# Implement ScalewayProvider Class

## Problem

Phase 2 of multi-provider support: implement the actual `ScalewayProvider` class in `packages/providers/` that calls the Scaleway Instance API. Phase 1 (PR #363) generalized the API layer. This phase adds the provider implementation.

## Research Findings

### Key Files
- `packages/providers/src/hetzner.ts` — reference implementation (254 lines)
- `packages/providers/src/types.ts` — Provider interface, ScalewayProviderConfig (already exists)
- `packages/providers/src/provider-fetch.ts` — HTTP wrapper with timeout + ProviderError
- `packages/providers/src/index.ts` — factory (currently throws for scaleway)
- `packages/providers/src/errors.ts` — ProviderError class
- `packages/shared/src/constants.ts` — constants pattern (DEFAULT_* with env var overrides)
- `tasks/backlog/2026-02-16-provider-scaleway.md` — Scaleway API research

### Scaleway API Quirks
1. **Three-step VM creation**: POST /servers → PATCH user_data/cloud-init → POST action poweron
2. **Servers created stopped** — must explicitly poweron
3. **Cannot delete running servers** — must poweroff first, then DELETE
4. **Public IP**: set `dynamic_ip_required: true` in create request
5. **Zone in URL path**: `https://api.scaleway.com/instance/v1/zones/{zone}/...`
6. **Auth header**: `X-Auth-Token: <secret_key>` (not Bearer)
7. **Tags as arrays** for label-like filtering
8. **Image lookup by name**: GET /images?name=ubuntu_noble

### Size Mappings
- small: DEV1-M (3 vCPU, 4GB RAM, 40GB) ~€0.024/hr
- medium: DEV1-XL (4 vCPU, 12GB RAM, 120GB) ~€0.048/hr
- large: GP1-S (8 vCPU, 32GB RAM, 600GB) ~€0.084/hr

### Locations
- fr-par-1, fr-par-2, fr-par-3 (Paris)
- nl-ams-1, nl-ams-2, nl-ams-3 (Amsterdam)
- pl-waw-1, pl-waw-2 (Warsaw)

## Implementation Checklist

- [ ] Add `DEFAULT_SCALEWAY_ZONE` constant to `packages/shared/src/constants.ts`
- [ ] Create `packages/providers/src/scaleway.ts` implementing Provider interface
  - [ ] Define SCALEWAY_API_URL, SCALEWAY_LOCATIONS, SCALEWAY_SIZES constants
  - [ ] Implement constructor (secretKey, projectId, zone)
  - [ ] Implement `createVM()` — three-step: create server, set cloud-init, poweron
  - [ ] Implement `deleteVM()` — poweroff first if running, then delete (idempotent on 404)
  - [ ] Implement `getVM()` — return null on 404
  - [ ] Implement `listVMs()` — filter by tags
  - [ ] Implement `powerOff()` / `powerOn()` — POST action
  - [ ] Implement `validateToken()` — GET /account/v3/projects
  - [ ] Add status mapping helper
  - [ ] Add server-to-VMInstance mapping helper
- [ ] Update `packages/providers/src/index.ts` — replace throw with ScalewayProvider instantiation
- [ ] Export ScalewayProvider from index
- [ ] Create `packages/providers/tests/fixtures/scaleway-mocks.ts` — mock helpers
- [ ] Create `packages/providers/tests/unit/scaleway.test.ts` — comprehensive tests
- [ ] Update `packages/providers/tests/unit/factory.test.ts` — scaleway returns ScalewayProvider
- [ ] Run quality checks (typecheck, lint, test, build)

## Acceptance Criteria

- [ ] ScalewayProvider implements all 7 Provider interface methods + name/locations/sizes
- [ ] Factory creates ScalewayProvider for scaleway config (no more "not yet implemented")
- [ ] All tests pass including new scaleway tests
- [ ] Error handling follows ProviderError pattern (like Hetzner)
- [ ] No hardcoded values — all defaults as configurable constants
- [ ] Typecheck, lint, test, build all pass
