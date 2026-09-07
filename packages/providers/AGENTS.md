# Providers Package (packages/providers)

## Purpose

Cloud provider abstraction layer. Implements the `Provider` interface for Hetzner, Scaleway,
Vultr, Infomaniak Public Cloud, DigitalOcean, UpCloud, and GCP. Used by the API Worker to
provision/manage VMs without coupling to a specific cloud vendor.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — provider classes and types |
| `src/types.ts` | `Provider` interface, `VMConfig`, `NativeVMConfig`, `VMInstance`, shared types |
| `src/native-vm-config.ts` | Native VM request resolver and the named legacy-size compatibility adapter |
| `src/hetzner.ts` | Hetzner Cloud provider implementation |
| `src/scaleway.ts` | Scaleway provider implementation |
| `src/gcp.ts` | GCP provider (partial/placeholder) |
| `src/provider-fetch.ts` | Shared HTTP fetch utilities for provider APIs |

## Commands

```bash
pnpm --filter @simple-agent-manager/providers build       # Compile TypeScript
pnpm --filter @simple-agent-manager/providers test        # Run Vitest
pnpm --filter @simple-agent-manager/providers typecheck   # Type check only
pnpm --filter @simple-agent-manager/providers lint        # ESLint
```

## Conventions

- Every provider implements the `Provider` interface from `src/types.ts`
- Every public VM and volume operation accepts an optional `ProviderRequestContext` and propagates
  it through HTTP, delays, retries, polling, pagination, and delegated helpers. Preserve the exact
  caller cancellation reason and begin no follow-up request or resource mutation after cancellation.
- Provider methods accept explicit credentials supplied by the caller. They do not read
  environment variables or decide whether a credential is user, project, or platform scoped.
- Location validation uses `PROVIDER_LOCATIONS` registry from `@simple-agent-manager/shared`
- New providers: create `src/<provider-name>.ts`, implement `Provider` interface, export from `src/index.ts`
- VM create paths use `VMConfig.native.instanceType` as the provider-native authority. Legacy
  `size` remains optional and is translated only through `resolveVMConfigWithLegacySizeAdapter()`.
  Do not read `config.size` in provider create implementations, request payloads, resource
  accounting, or observed-hardware mapping.
- `VMInstance.observedHardware` reports facts from provider responses. Use `observed` only for
  fields returned by the provider, and `unknown` when a provider omits resource details. Do not infer
  actual hardware from `small`/`medium`/`large`.

## Gotchas

- Depends on `@simple-agent-manager/shared` — build shared first
- Provider API tokens come from user credentials (encrypted in D1), NOT from environment variables
- Tests mock HTTP responses — real API calls are only made on staging with user-supplied tokens
- Hetzner labels are used as metadata storage (workspace ID, node ID) — label format matters
