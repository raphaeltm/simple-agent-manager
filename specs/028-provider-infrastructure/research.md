# Research: Provider Interface Modernization

## R1: VMConfig Design — Secrets vs. Operational Parameters

**Decision**: VMConfig contains ONLY non-secret operational parameters: `name`, `size`, `location`, `userData`, `labels`, `image`.

**Rationale**: The current `VMConfig` bundles secrets (`authPassword`, `apiToken`, `baseDomain`, `apiUrl`, `githubToken`) with operational config. This violates separation of concerns — the provider doesn't need secrets; it just passes them through to cloud-init. Since `@simple-agent-manager/cloud-init` already generates the complete cloud-init script (including secrets), the provider only needs to receive the finished `userData` string.

**Alternatives considered**:
- Keep secrets in VMConfig but mark them as opaque — rejected because it keeps the type leaky and tempts direct access
- Pass secrets separately via a `SecretsConfig` — rejected as over-engineering; the caller already has them for cloud-init generation

## R2: providerFetch vs. Existing fetchWithTimeout

**Decision**: Create `providerFetch` in `packages/providers/src/provider-fetch.ts` that wraps fetch with timeout + `ProviderError` normalization. Move `getTimeoutMs` helper alongside it. Delete `apps/api/src/services/fetch-timeout.ts`.

**Rationale**: The existing `fetchWithTimeout` in the API layer is a general utility. The providers package needs the same timeout behavior PLUS automatic error wrapping into `ProviderError` with provider name and HTTP status. Rather than importing from the API into a package (which violates dependency direction: packages → apps is forbidden), we create the utility in the providers package and have the API import from there if needed.

**Alternatives considered**:
- Keep fetchWithTimeout in API and duplicate in providers — rejected due to DRY violation
- Create a shared `packages/fetch` package — rejected as over-engineering for a single utility
- Use an existing library (ky, ofetch) — rejected per Principle X (simplicity); our needs are minimal

## R3: Factory Design — Explicit Config vs. process.env

**Decision**: `createProvider(config: ProviderConfig)` accepts an explicit discriminated union config. No `process.env` access anywhere in the providers package.

**Rationale**: Cloudflare Workers don't have `process.env`. The current factory reads `process.env.PROVIDER_TYPE` and `process.env.HETZNER_TOKEN`, which fails in Workers. The API layer already has the decrypted token and knows the provider type from the credentials table, so it can construct the config explicitly.

**Alternatives considered**:
- Accept a generic `Record<string, string>` — rejected because it loses type safety
- Accept individual parameters — rejected because discriminated union scales better to multiple providers

## R4: ProviderError Design

**Decision**: `ProviderError extends Error` with `providerName: string`, `statusCode?: number`, and `cause?: Error`. Thrown by `providerFetch` on HTTP errors and timeouts, and by provider methods on domain-specific failures.

**Rationale**: Callers need to distinguish provider errors from other errors for logging, error messages, and retry decisions. Including the provider name enables multi-provider error reporting.

**Alternatives considered**:
- Return `Result<T, ProviderError>` instead of throwing — rejected because the codebase uses throw/catch consistently
- Use error codes enum — rejected as YAGNI; HTTP status codes are sufficient for now

## R5: Contract Test Suite Design

**Decision**: A reusable test suite exported as a function `runProviderContractTests(createProvider: () => Provider)` that any provider implementation can call with its own factory. Tests validate all interface methods against a mock HTTP server.

**Rationale**: Contract tests ensure every provider implementation satisfies the same behavioral contract. The test suite is parameterized by a factory function so new providers just call it with their own setup.

**Alternatives considered**:
- Abstract test class — rejected because Vitest doesn't use class-based tests
- Snapshot testing — rejected because provider responses are dynamic
- Only unit tests per provider — rejected because it doesn't guarantee interface compliance

## R6: DevcontainerProvider Removal

**Decision**: Delete `packages/providers/src/devcontainer.ts` entirely. No replacement.

**Rationale**: DevcontainerProvider uses `child_process.exec`, `fs/promises`, and `path` — all Node.js-only APIs incompatible with Cloudflare Workers. It was designed for local development but the project's development approach is Cloudflare-first (deploy to staging for real testing). It has no active consumers.

**Alternatives considered**:
- Keep it behind a dynamic import — rejected because it still pollutes the package exports and confuses contributors
- Move it to a separate package — rejected because nobody uses it

## R7: API Migration Strategy

**Decision**: Migrate `apps/api/src/services/nodes.ts` incrementally:
1. Create `HetznerProvider` instance from decrypted credentials in `provisionNode()`, `stopNodeResources()`, `deleteNodeResources()`
2. Replace `createServer()` → `provider.createVM()`, `deleteServer()` → `provider.deleteVM()`, etc.
3. Replace `validateHetznerToken()` in `credentials.ts` with `provider.validateToken()`
4. Delete `apps/api/src/services/hetzner.ts` and `fetch-timeout.ts`

**Rationale**: The migration must be atomic — all flat function calls replaced in one PR to avoid a mixed state where some calls go through the provider and some go through flat functions.

**Alternatives considered**:
- Gradual migration over multiple PRs — rejected because it leaves the codebase in an inconsistent state
- Create an adapter layer — rejected as unnecessary indirection; the provider interface IS the adapter

## R8: Hetzner API URL Hardcoding

**Decision**: Keep `HETZNER_API_URL = 'https://api.hetzner.cloud/v1'` as a constant in the HetznerProvider. This is NOT a Constitution XI violation.

**Rationale**: The Hetzner Cloud API URL is a truly constant value — it's defined by Hetzner's API specification and doesn't change across deployments. Making it configurable would suggest it could be something else, which is misleading. Constitution XI explicitly exempts "protocol versions and similar invariants."

**Alternatives considered**:
- Make it configurable via ProviderConfig — rejected because no deployment would ever change it
- Derive from env var — rejected as false configurability
