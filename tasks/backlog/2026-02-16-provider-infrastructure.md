# Provider Interface Modernization + Hetzner Migration

**Created**: 2026-02-16
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Large
**Branch**: `feat/multi-provider-support`
**Depends On**: None (this is the foundation)
**Blocks**: All provider implementation tasks (`provider-upcloud`, `provider-digitalocean`, etc.)

## Context

SAM currently has two provider layers that do the same thing differently:

1. **`packages/providers/`** — A `Provider` interface with `HetznerProvider` and `DevcontainerProvider`. **Not used by the API.** The `HetznerProvider` here has a stale, insecure `generateCloudInit()` that embeds secrets in plaintext. Dead code.
2. **`apps/api/src/services/hetzner.ts`** — Flat functions (`createServer`, `deleteServer`, `powerOffServer`, `powerOnServer`, `validateHetznerToken`) that the API actually calls. Invoked from `apps/api/src/services/nodes.ts`.

This task modernizes `packages/providers/` into a clean abstraction, migrates the API to use it, and deletes the flat Hetzner service functions. After this task, adding a new provider means implementing the `Provider` interface and passing the contract test suite — nothing else changes.

## Problem Statement

1. `generateCloudInit()` on the `Provider` interface is a security problem — providers should NOT generate cloud-init (that's `@simple-agent-manager/cloud-init`'s job)
2. `VMConfig` contains legacy fields (`authPassword`, `apiToken`, `baseDomain`, `apiUrl`, `githubToken`) that embed secrets
3. `ProviderConfig` only supports single-token auth — UpCloud needs user+pass, future providers need multi-field auth
4. No `powerOff()` / `powerOn()` / `validateToken()` on the interface
5. `DevcontainerProvider` uses `node:child_process` which can't run in Workers — its purpose is unclear
6. The API uses flat functions in `services/hetzner.ts` instead of the `Provider` abstraction, so adding providers requires duplicating the dispatch pattern in `nodes.ts`
7. `fetchWithTimeout()` exists in `apps/api/src/services/fetch-timeout.ts` but isn't available to the providers package
8. Factory in `packages/providers/src/index.ts` reads `process.env` which doesn't work in Workers

## Scope

### In Scope

- Modernize `Provider` interface (remove `generateCloudInit`, add lifecycle methods)
- Clean up `VMConfig` (remove legacy secret fields, add `userData` and `labels`)
- Make `ProviderConfig` a discriminated union (Hetzner + UpCloud only — don't define configs for unimplemented providers)
- Lift `fetchWithTimeout()` from `apps/api/src/services/fetch-timeout.ts` into `packages/providers/` as `providerFetch()`
- Create `ProviderError` class for normalized error handling
- Create reusable contract test suite
- Modernize `HetznerProvider` to implement new interface
- **Migrate API**: Rewrite `apps/api/src/services/nodes.ts` to use the `Provider` interface instead of flat `services/hetzner.ts` functions
- **Delete `apps/api/src/services/hetzner.ts`** (replaced by `HetznerProvider`)
- Update factory to accept env parameter (no `process.env`)
- Drop `DevcontainerProvider` (or stub it with `throw new Error('not supported in Workers')` for methods that need child_process)
- TDD: tests first, >90% coverage

### Out of Scope

- Implementing any non-Hetzner provider (separate tasks in backlog)
- UI changes for provider selection
- Database schema changes for multi-provider credentials (already done — `credentials` table has `provider` column)
- Expanding `CredentialProvider` beyond `'hetzner' | 'upcloud'` (it's already correct in `packages/shared/src/types.ts`)

## Technical Design

### New Provider Interface

```typescript
interface Provider {
  /** Provider identifier (matches CredentialProvider type) */
  readonly name: CredentialProvider;

  /** Available locations/regions for this provider */
  readonly locations: readonly ProviderLocation[];

  /** Available VM sizes for this provider */
  readonly sizes: readonly ProviderSize[];

  // VM lifecycle
  createVM(config: VMConfig): Promise<VMInstance>;
  deleteVM(id: string): Promise<void>;        // Idempotent (no error on 404)
  getVM(id: string): Promise<VMInstance | null>;
  listVMs(labels?: Record<string, string>): Promise<VMInstance[]>;
  powerOff(id: string): Promise<void>;
  powerOn(id: string): Promise<void>;

  // Credential validation
  validateToken(): Promise<boolean>;
}
```

### New VMConfig (Clean — no secrets)

```typescript
interface VMConfig {
  name: string;                        // Server name
  size: string;                        // Provider-specific size identifier
  location: string;                    // Provider-specific location/region
  userData: string;                    // Pre-generated cloud-init from @simple-agent-manager/cloud-init
  labels: Record<string, string>;      // For filtering in listVMs
  image?: string;                      // Provider-specific image (optional, provider has default)
}
```

### ProviderConfig (Only implemented providers)

```typescript
type ProviderConfig =
  | { provider: 'hetzner'; apiToken: string }
  | { provider: 'upcloud'; username: string; password: string };
```

New variants are added here only when a provider implementation task is completed.

### Provider Factory (Workers-compatible)

```typescript
// Accepts config directly — no process.env
function createProvider(config: ProviderConfig): Provider;
```

### Shared HTTP Helpers (lifted from fetch-timeout.ts)

```typescript
// Wraps fetch with timeout, AbortController, error normalization
async function providerFetch(url: string, init?: RequestInit, timeoutMs?: number): Promise<Response>

// Parse timeout from env string with default
function getTimeoutMs(envValue: string | undefined, defaultMs?: number): number

// Standard error type all providers throw
class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
    public readonly cause?: unknown
  )
}
```

### API Migration (nodes.ts)

Current pattern in `nodes.ts`:
```typescript
// BAD: flat functions + manual dispatch
import { createServer, deleteServer, powerOffServer } from './hetzner';
if (provider === 'upcloud') {
  await createUpcloudServer(token, options, env);
} else {
  await createServer(token, options, env);
}
```

New pattern:
```typescript
// GOOD: polymorphic dispatch
import { createProvider } from '@simple-agent-manager/providers';
const provider = createProvider({ provider: providerType, ...credentials });
await provider.createVM(config);
```

## Implementation Checklist

### Phase 1: Types + Helpers

- [ ] Define new `Provider` interface in `packages/providers/src/types.ts`
- [ ] Clean up `VMConfig` — remove `authPassword`, `apiToken`, `baseDomain`, `apiUrl`, `githubToken`; add `userData`, `labels`
- [ ] Add `ProviderLocation` and `ProviderSize` metadata types
- [ ] Define `ProviderConfig` discriminated union (Hetzner + UpCloud only)
- [ ] Lift `fetchWithTimeout()` from `apps/api/src/services/fetch-timeout.ts` into `packages/providers/src/fetch.ts`
- [ ] Create `ProviderError` class in `packages/providers/src/errors.ts`
- [ ] Write tests for `providerFetch` and `ProviderError`

### Phase 2: Contract Test Suite

- [ ] Create reusable contract test suite (`packages/providers/tests/contract/`) that any `Provider` implementation can run against
- [ ] Contract covers: createVM request shape, deleteVM idempotency, listVMs label filtering, getVM null on missing, powerOff/powerOn, validateToken (valid + invalid), error handling

### Phase 3: Modernize HetznerProvider

- [ ] Remove `generateCloudInit()` from `HetznerProvider`
- [ ] Accept `userData` field from VMConfig (pre-generated cloud-init)
- [ ] Add `powerOff()`, `powerOn()`, `validateToken()` methods
- [ ] Use `providerFetch()` for all HTTP calls
- [ ] Throw `ProviderError` on failures
- [ ] Add `locations` and `sizes` static metadata
- [ ] Pass contract test suite
- [ ] Unit tests with mocked fetch, >90% coverage

### Phase 4: Update Factory

- [ ] Rewrite `createProvider(config: ProviderConfig): Provider` — accepts config, no `process.env`
- [ ] Export all types and provider classes from `packages/providers/src/index.ts`
- [ ] Remove `DevcontainerProvider` (or decide its fate — see notes below)

### Phase 5: API Migration

- [ ] Rewrite `apps/api/src/services/nodes.ts` to use `createProvider()` + `Provider` interface
- [ ] Remove `if (provider === 'upcloud') { ... } else { ... }` dispatch pattern
- [ ] Delete `apps/api/src/services/hetzner.ts` (all its functions now live in `HetznerProvider`)
- [ ] Delete `apps/api/src/services/fetch-timeout.ts` (lifted to providers package)
- [ ] Update `apps/api/src/services/nodes.ts` imports
- [ ] Verify all existing API tests still pass
- [ ] Run `pnpm typecheck` and `pnpm build` from root

### Phase 6: Cleanup

- [ ] Remove `generateCloudInit` from `Provider` interface in types
- [ ] Remove stale `VMConfig` fields from types
- [ ] Update `packages/providers/package.json` if dependencies changed
- [ ] Search docs for references to `services/hetzner.ts` and update them
- [ ] Update CLAUDE.md/AGENTS.md if relevant (e.g., "Related Files" section)

## DevcontainerProvider Decision

`DevcontainerProvider` uses `node:child_process` and `node:fs` — it cannot run in Cloudflare Workers. Options:

1. **Delete it.** CLAUDE.md says local dev has significant limitations and real testing should use staging. Nobody calls this provider from the API.
2. **Stub it.** Keep the class but throw `new Error('DevcontainerProvider is not supported in Workers runtime')` for all methods. Keeps the interface implementation for reference.
3. **Move it to a dev-only package.** Overkill for a pre-production project.

**Recommendation**: Delete it. It's dead code. If local dev simulation is ever needed, it can be reimplemented.

## Testing Strategy

- **Contract tests**: Reusable suite that validates any `Provider` implementation (pass the class, the suite verifies all interface methods)
- **Unit tests**: Per-method tests for `HetznerProvider` with mocked `providerFetch`
- **Helper tests**: `providerFetch` timeout, abort, error wrapping; `ProviderError` serialization
- **Integration**: After API migration, ensure `nodes.ts` provisioning flow works end-to-end with mocked provider

## Dependencies

- `packages/shared` — types (`CredentialProvider`, `VMSize`, `VMLocation`)
- `packages/cloud-init` — generates `userData` string passed to `VMConfig`

## Related Files

| File | Role |
|------|------|
| `packages/providers/src/types.ts` | Current types (to be modernized) |
| `packages/providers/src/hetzner.ts` | Current dead-code implementation (to be modernized) |
| `packages/providers/src/devcontainer.ts` | Local dev provider (to be deleted) |
| `packages/providers/src/index.ts` | Factory (to be rewritten) |
| `packages/shared/src/types.ts` | `CredentialProvider` (`'hetzner' | 'upcloud'` — already correct) |
| `packages/shared/src/constants.ts` | `VM_SIZE_CONFIG`, `VM_LOCATIONS`, `UPCLOUD_SIZE_CONFIG` |
| `packages/cloud-init/src/generate.ts` | Secure cloud-init generator |
| `apps/api/src/services/hetzner.ts` | Flat Hetzner functions (to be deleted after migration) |
| `apps/api/src/services/fetch-timeout.ts` | `fetchWithTimeout()` (to be lifted into providers package) |
| `apps/api/src/services/nodes.ts` | Node provisioning orchestration (to be migrated) |

## Success Criteria

- [ ] New `Provider` interface with all lifecycle methods, no `generateCloudInit`
- [ ] `VMConfig` contains no secret fields
- [ ] `ProviderConfig` discriminated union for Hetzner + UpCloud (no speculative configs)
- [ ] `HetznerProvider` fully modernized and passing contract tests
- [ ] `providerFetch()` available in providers package (no duplicate in API)
- [ ] Factory accepts config parameter (no `process.env`)
- [ ] API `nodes.ts` uses `Provider` interface (no flat function imports)
- [ ] `apps/api/src/services/hetzner.ts` deleted
- [ ] `DevcontainerProvider` deleted (or explicitly stubbed)
- [ ] Contract test suite ready for future provider implementations
- [ ] All existing tests still pass
- [ ] >90% test coverage on `packages/providers`
- [ ] `pnpm typecheck && pnpm build && pnpm test` pass from root
