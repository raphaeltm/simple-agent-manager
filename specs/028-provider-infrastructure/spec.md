# Feature Specification: Provider Interface Modernization

**Feature Branch**: `028-provider-infrastructure`
**Created**: 2026-03-12
**Status**: Draft
**Input**: User description: "Provider Interface Modernization + Hetzner Migration"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Platform Developer Adds a New Cloud Provider (Priority: P1)

A platform developer wants to add support for a new cloud provider (e.g., UpCloud, DigitalOcean). They implement the `Provider` interface, run the contract test suite to verify compliance, and register the provider in the factory. No changes are needed to the API orchestration layer, credentials flow, or UI.

**Why this priority**: This is the core value proposition. The entire BYOC (Bring-Your-Own-Cloud) strategy depends on making provider addition a bounded, well-defined task rather than a cross-cutting change.

**Independent Test**: Can be tested by implementing a mock provider, running the contract test suite, and verifying all tests pass without modifying any code outside the providers package.

**Acceptance Scenarios**:

1. **Given** a new provider class implementing the `Provider` interface, **When** the developer runs the contract test suite against it, **Then** all contract tests pass or fail with clear diagnostic messages about which interface methods are non-compliant.
2. **Given** a new provider registered in the factory, **When** the API creates a node using that provider, **Then** the orchestration layer calls the provider polymorphically with no provider-specific branching.
3. **Given** a provider implementation that throws errors, **When** operations fail, **Then** all errors are normalized into a standard `ProviderError` with provider name, status code, and cause.

---

### User Story 2 - API Provisions a Node Using the Provider Interface (Priority: P1)

The API's node orchestration (`nodes.ts`) creates, deletes, and manages VMs through the `Provider` interface rather than calling flat Hetzner-specific functions directly. The provider is resolved from the user's credential type (e.g., `hetzner`) and their decrypted token.

**Why this priority**: This is the migration that eliminates the current dual-layer architecture. Without it, the provider abstraction exists but isn't used.

**Independent Test**: Can be tested by provisioning a node end-to-end on staging and verifying the provider interface is called instead of flat functions.

**Acceptance Scenarios**:

1. **Given** a user with Hetzner credentials, **When** they create a node, **Then** the system resolves a `HetznerProvider` instance and calls `createVM()` with a clean `VMConfig` (no secrets in config, cloud-init passed as `userData`).
2. **Given** a user deleting a node, **When** the deletion is triggered, **Then** the system calls `provider.deleteVM()` which is idempotent (no error on 404).
3. **Given** the API receives a token validation request, **When** credentials are being saved, **Then** the system calls `provider.validateToken()` on a `HetznerProvider` instance.

---

### User Story 3 - Dead Code Removal (Priority: P2)

The platform removes dead code that creates maintenance confusion and security risk: the old `HetznerProvider` with its insecure `generateCloudInit()`, the `DevcontainerProvider` that cannot run in Workers, the flat `hetzner.ts` service functions (replaced by the provider), and the `fetchWithTimeout` utility (lifted into the providers package).

**Why this priority**: Dead code removal reduces confusion for new contributors and eliminates the security risk of the insecure cloud-init generator.

**Independent Test**: Can be tested by verifying that the deleted files no longer exist, all imports resolve correctly, and `pnpm typecheck && pnpm build && pnpm test` pass.

**Acceptance Scenarios**:

1. **Given** the old `DevcontainerProvider`, **When** the migration is complete, **Then** the file is deleted and no code references it.
2. **Given** `apps/api/src/services/hetzner.ts`, **When** the migration is complete, **Then** the file is deleted and `nodes.ts` uses the provider interface exclusively.
3. **Given** `apps/api/src/services/fetch-timeout.ts`, **When** the migration is complete, **Then** `fetchWithTimeout` lives in the providers package as `providerFetch` and the API imports it from there.

---

### User Story 4 - Workers-Compatible Provider Factory (Priority: P2)

The provider factory accepts an explicit configuration object (no `process.env` access) and returns a typed `Provider` instance. The factory works in Cloudflare Workers where `process.env` is not available.

**Why this priority**: Required for the API migration since the API runs in Workers.

**Independent Test**: Can be tested by calling `createProvider()` with a config object and verifying it returns the correct provider without any environment variable access.

**Acceptance Scenarios**:

1. **Given** a Hetzner config `{ provider: 'hetzner', apiToken: 'xxx' }`, **When** `createProvider()` is called, **Then** a `HetznerProvider` instance is returned.
2. **Given** an unknown provider type, **When** `createProvider()` is called, **Then** a clear error is thrown indicating the provider is not supported.
3. **Given** the factory function, **When** inspected for runtime dependencies, **Then** it does not access `process.env` or any Node.js-only APIs.

---

### Edge Cases

- What happens when a provider API returns a non-JSON error response? The `providerFetch` wrapper must handle both JSON and text error bodies gracefully.
- What happens when a provider API request times out? The `providerFetch` wrapper must abort the request and throw a `ProviderError` with a clear timeout message.
- What happens when `deleteVM` is called for a VM that was already deleted? It must be idempotent (no error on 404).
- What happens when `listVMs` is called with label filters that match no VMs? It must return an empty array, not throw.
- What happens when `getVM` is called for a non-existent ID? It must return `null`, not throw.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `Provider` interface MUST include methods for: `createVM`, `deleteVM`, `getVM`, `listVMs`, `powerOff`, `powerOn`, and `validateToken`.
- **FR-002**: The `Provider` interface MUST expose `name` (matching credential provider type), `locations` (available regions), and `sizes` (available VM configurations) as readonly properties.
- **FR-003**: The `Provider` interface MUST NOT include `generateCloudInit` -- cloud-init generation is the responsibility of the `@simple-agent-manager/cloud-init` package.
- **FR-004**: The `VMConfig` type MUST accept `name`, `size`, `location`, `userData` (pre-generated cloud-init), `labels`, and optional `image` -- it MUST NOT contain secret fields (`authPassword`, `apiToken`, `baseDomain`, `apiUrl`, `githubToken`).
- **FR-005**: The `ProviderConfig` type MUST be a discriminated union supporting at minimum Hetzner (API token) and UpCloud (username + password) authentication shapes.
- **FR-006**: The `createProvider` factory MUST accept a `ProviderConfig` parameter directly and MUST NOT access `process.env`.
- **FR-007**: All provider HTTP calls MUST use a shared `providerFetch` utility with configurable timeout and `AbortController`-based cancellation.
- **FR-008**: All provider errors MUST be wrapped in a `ProviderError` class that includes provider name, HTTP status code (if applicable), and original cause.
- **FR-009**: `deleteVM` MUST be idempotent -- a 404 response from the provider API MUST NOT cause an error.
- **FR-010**: `listVMs` MUST support optional label-based filtering.
- **FR-011**: `getVM` MUST return `null` for non-existent VMs rather than throwing.
- **FR-012**: The `HetznerProvider` MUST implement all `Provider` interface methods using the Hetzner Cloud API.
- **FR-013**: A reusable contract test suite MUST exist that any `Provider` implementation can run to verify interface compliance.
- **FR-014**: The API's node orchestration (`nodes.ts`) MUST use the `Provider` interface for all VM operations instead of flat Hetzner-specific functions.
- **FR-015**: The API's credential validation (`credentials.ts`) MUST use `provider.validateToken()` instead of the standalone `validateHetznerToken()` function.
- **FR-016**: The `DevcontainerProvider` MUST be deleted (dead code that uses Node.js-only APIs incompatible with Workers).
- **FR-017**: The flat `apps/api/src/services/hetzner.ts` MUST be deleted after migration.
- **FR-018**: The `fetchWithTimeout` utility MUST be moved from `apps/api/src/services/fetch-timeout.ts` to `packages/providers/` and the API MUST import from the new location.

### Key Entities

- **Provider**: Cloud infrastructure provider abstraction with VM lifecycle management capabilities. Has a name, supported locations, supported sizes, and credential configuration.
- **VMConfig**: Configuration for creating a new VM. Contains non-secret operational parameters: name, size, location, cloud-init user data, and metadata labels.
- **VMInstance**: Representation of a provisioned VM as returned by the provider. Contains ID, name, IP, status, server type, creation timestamp, and labels.
- **ProviderConfig**: Discriminated union of authentication configurations per provider type. Hetzner uses a single API token; UpCloud uses username + password.
- **ProviderError**: Normalized error type for all provider operations. Contains provider name, HTTP status code, human-readable message, and original cause.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Adding a new provider requires implementing only the `Provider` interface and registering in the factory -- no changes to API routes, orchestration, or UI code.
- **SC-002**: The provider contract test suite validates all interface methods and can be reused across provider implementations with zero modification.
- **SC-003**: All existing node provisioning, deletion, and lifecycle operations continue to work identically after migration (no user-visible behavior changes).
- **SC-004**: The `VMConfig` type contains zero secret fields -- secrets are managed by the caller, not passed through provider configuration.
- **SC-005**: The providers package has >90% test coverage.
- **SC-006**: `pnpm typecheck`, `pnpm build`, `pnpm lint`, and `pnpm test` all pass from the repository root after migration.
- **SC-007**: No code in the providers package accesses `process.env` or Node.js-only APIs (`child_process`, `fs`).

## Assumptions

- The `CredentialProvider` type in `packages/shared/src/types.ts` (currently `'hetzner'`) will be expanded to include `'upcloud'` when the UpCloud provider implementation task is completed. This spec only adds the `ProviderConfig` union variant for UpCloud, not the implementation.
- The database schema already supports multi-provider credentials via the `provider` column on the `credentials` table.
- No UI changes are needed -- provider selection will be addressed in a separate feature.
- The `@simple-agent-manager/cloud-init` package already generates complete cloud-init scripts. The provider receives these as an opaque `userData` string.

## Scope Boundaries

### In Scope
- Modernize `Provider` interface and related types
- Implement `HetznerProvider` against new interface
- Create `providerFetch` and `ProviderError` utilities
- Create reusable contract test suite
- Migrate API `nodes.ts` and `credentials.ts` to use provider interface
- Delete dead code (`DevcontainerProvider`, old `hetzner.ts`, old `fetch-timeout.ts`)
- Workers-compatible factory

### Out of Scope
- Implementing any non-Hetzner provider (separate tasks)
- UI changes for provider selection
- Database schema changes (already supports multi-provider)
- Expanding `CredentialProvider` type beyond current value
