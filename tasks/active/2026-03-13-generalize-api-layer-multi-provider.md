# Generalize API Layer for Multi-Provider Support

**Created**: 2026-03-13
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium
**Branch**: `feat/generalize-api-multi-provider`
**Depends On**: `2026-02-16-provider-infrastructure.md` (archived, completed)

## Context

The provider interface (spec 028) is production-ready and provider-agnostic, but the API layer that uses it is hardcoded to Hetzner in 6+ locations across credentials, nodes, and task routes. This blocks any new provider implementation from actually working end-to-end.

This task generalizes the API layer so any provider that implements the `Provider` interface can be used without API code changes.

## Research Findings

### Hardcoded Hetzner References (must fix)

| File | Line(s) | Issue |
|------|---------|-------|
| `apps/api/src/routes/credentials.ts` | 64 | Hard rejects non-hetzner: `if (body.provider !== 'hetzner')` |
| `apps/api/src/routes/credentials.ts` | 43, 110, 132 | `provider: cred.provider as 'hetzner'` casts |
| `apps/api/src/routes/credentials.ts` | 71 | Creates provider with `apiToken` only |
| `apps/api/src/services/nodes.ts` | 104, 213, 294 | `eq(schema.credentials.provider, 'hetzner')` lookups |
| `apps/api/src/services/nodes.ts` | 140, 224, 303 | `createProvider({ provider: 'hetzner', apiToken })` |
| `apps/api/src/services/nodes.ts` | 149 | Uses `HETZNER_IMAGE` constant |
| `apps/api/src/routes/tasks/submit.ts` | 84 | `eq(schema.credentials.provider, 'hetzner')` |
| `apps/api/src/routes/tasks/run.ts` | 111 | `eq(schema.credentials.provider, 'hetzner')` |

### Credential Storage Design Decision

The DB `credentials` table stores `encryptedToken` (text) + `iv` (text). For multi-field credentials (Scaleway needs secretKey + projectId), we'll encrypt a JSON string. For single-field providers (Hetzner), the encrypted value is just the API token (backward compatible).

A helper `buildProviderConfig(providerName, decryptedToken)` will parse the decrypted value into the correct `ProviderConfig`:
- `hetzner` → raw string treated as `apiToken`
- `scaleway` → JSON parsed to extract `secretKey` and `projectId`

### Key Patterns

- `CredentialProvider` type in shared controls valid provider names
- `ProviderConfig` discriminated union in providers controls per-provider config shapes
- `createProvider()` factory dispatches to the right class
- `UpCloudProviderConfig` already exists in types (from spec 028) but has no implementation
- DB schema uses text `provider` column — no migration needed

## Implementation Checklist

### Type Updates
- [ ] Add `'scaleway'` to `CredentialProvider` union in `packages/shared/src/types.ts`
- [ ] Update `CreateCredentialRequest` to support provider-specific credential shapes
- [ ] Add `ScalewayProviderConfig` to `ProviderConfig` union in `packages/providers/src/types.ts`
- [ ] Add `'scaleway'` case to `createProvider()` factory (throw "not yet implemented")
- [ ] Export new types from `packages/providers/src/index.ts`

### Credential Helper (new)
- [ ] Create `buildProviderConfig()` helper in `apps/api/src/services/provider-credentials.ts`
- [ ] Create `serializeCredentialToken()` helper for encrypting multi-field credentials
- [ ] Create `getUserCloudProviderCredential()` helper that finds+decrypts+builds ProviderConfig

### API Route Generalization
- [ ] Remove `if (body.provider !== 'hetzner')` guard in credentials.ts
- [ ] Accept provider-specific credential body shapes in POST /api/credentials
- [ ] Remove `as 'hetzner'` type casts — use `CredentialProvider` type properly
- [ ] Validate credentials against the provider using `createProvider().validateToken()`

### Nodes Service Generalization
- [ ] Extract `getUserCloudProviderCredential()` to replace 3 duplicated credential lookup blocks
- [ ] Remove hardcoded `'hetzner'` from credential queries — look up user's cloud-provider credential
- [ ] Remove hardcoded `createProvider({ provider: 'hetzner', apiToken })` — use helper
- [ ] Remove `HETZNER_IMAGE` usage — let provider handle default images via `config.image` being optional

### Task Routes Generalization
- [ ] Update `apps/api/src/routes/tasks/submit.ts` credential check
- [ ] Update `apps/api/src/routes/tasks/run.ts` credential check

### Tests
- [ ] Unit tests for `buildProviderConfig()` and `serializeCredentialToken()`
- [ ] Update factory test for scaleway case
- [ ] Integration tests for generalized credential CRUD

## Acceptance Criteria

- [ ] All 6+ hardcoded Hetzner references removed from API layer
- [ ] Existing Hetzner credential flow works identically (backward compatible)
- [ ] Scaleway credential creation/validation path works (returns "not yet implemented" from factory)
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build` all pass
- [ ] No DB migration required

## Related Files

- `packages/shared/src/types.ts` — CredentialProvider, CreateCredentialRequest
- `packages/providers/src/types.ts` — ProviderConfig union
- `packages/providers/src/index.ts` — createProvider factory
- `apps/api/src/routes/credentials.ts` — credential CRUD
- `apps/api/src/services/nodes.ts` — node provisioning/lifecycle
- `apps/api/src/routes/tasks/submit.ts` — task submission credential check
- `apps/api/src/routes/tasks/run.ts` — task run credential check
- `tasks/backlog/2026-02-16-provider-scaleway.md` — Scaleway API research
