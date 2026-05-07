# Providers Package (packages/providers)

## Purpose

Cloud provider abstraction layer. Implements the `Provider` interface for Hetzner and Scaleway (with GCP placeholder). Used by the API Worker to provision/manage VMs without coupling to a specific cloud vendor.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — provider classes and types |
| `src/types.ts` | `Provider` interface, `VMConfig`, `VMInstance`, shared types |
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
- Provider methods accept user-supplied API tokens (BYOC model) — never platform credentials
- Location validation uses `PROVIDER_LOCATIONS` registry from `@simple-agent-manager/shared`
- New providers: create `src/<provider-name>.ts`, implement `Provider` interface, export from `src/index.ts`

## Gotchas

- Depends on `@simple-agent-manager/shared` — build shared first
- Provider API tokens come from user credentials (encrypted in D1), NOT from environment variables
- Tests mock HTTP responses — real API calls are only made on staging with user-supplied tokens
- Hetzner labels are used as metadata storage (workspace ID, node ID) — label format matters
