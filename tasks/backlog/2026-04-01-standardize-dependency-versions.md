# Standardize Dependency Versions + pnpm Catalog + Pin Deps

## Problem Statement

The monorepo has 189 dependencies using `^` (caret) ranges across 15 package.json files, no pnpm catalog for version centralization, and version mismatches in critical tooling (Vitest 2.x vs 4.x). This creates supply chain risk and version drift.

## Research Findings

### Current State (15 package.json files)
- **189 deps** using `^` ranges, **0** using `~`, **5** using `workspace:*`
- **No pnpm catalog** configured in `pnpm-workspace.yaml`
- pnpm 9.0.0 installed — supports catalogs natively

### Version Mismatches
1. **Vitest**: `packages/ui` uses `^4.0.18` (resolves to 4.0.18), all others use `^2.0.0`/`^2.1.0` (resolve to 2.1.9)
2. **Vite**: Direct deps in `apps/web` and `packages/vm-agent/ui` both at `^5.0.0` (resolves to 5.4.21). Vite 6.4.1 installed as transitive dep from Vitest 4.x
3. **TypeScript**: Most use `^5.0.0`, `apps/tail-worker` and `infra` use `^5.7.0`, `packages/cloud-init` uses `^5.3.0`
4. **@types/node**: Root uses `^20.0.0`, `infra` uses `^22.10.0`

### Upgrade Compatibility (Verified)
- **Vitest 4.1.2** — latest stable, requires `vite ^6.0.0 || ^7.0.0 || ^8.0.0`
- **Vite 6.4.1** — latest 6.x stable
- **@cloudflare/vitest-pool-workers 0.14.0** — requires `vitest ^4.1.0` (compatible with upgrade)
- **@vitejs/plugin-react 5.2.0** — supports `vite ^6.0.0`
- **@tailwindcss/vite 4.2.2** — supports `vite ^6`
- **@vitest/coverage-v8 4.1.2** — requires `vitest 4.1.2`

### Key Constraint
- `@cloudflare/vitest-pool-workers` 0.5.x requires Vitest `2.0.x - 2.1.x` — upgrading Vitest to 4.x REQUIRES upgrading this to 0.14.0 simultaneously

## Implementation Checklist

### Phase 1: Set up pnpm catalog structure
- [ ] Add `catalog:` section to `pnpm-workspace.yaml` with all shared deps
- [ ] Start with devDependencies that appear in 3+ packages: `typescript`, `vitest`, `eslint`, `@typescript-eslint/*`, `@testing-library/*`, `prettier`
- [ ] Add shared production deps: `react`, `react-dom`, `vite`, `hono`, `drizzle-orm`, `better-auth`, `lucide-react`, `tailwindcss`

### Phase 2: Pin all versions (remove ^ and ~)
- [ ] Determine target pinned versions for all deps (use currently resolved versions from lockfile where possible)
- [ ] Update all package.json files: replace `^x.y.z` with exact `x.y.z`
- [ ] For catalog deps: use exact versions in catalog, reference with `catalog:` in package.json
- [ ] For non-catalog deps (unique to one package): pin in-place

### Phase 3: Upgrade Vite 5→6 + Vitest 2→4
- [ ] Upgrade `vite` to `6.4.1` in catalog
- [ ] Upgrade `@vitejs/plugin-react` to `5.2.0`
- [ ] Upgrade `@tailwindcss/vite` to `4.2.2`
- [ ] Upgrade `vitest` to `4.1.2` in catalog
- [ ] Upgrade `@vitest/coverage-v8` to `4.1.2`
- [ ] Upgrade `@cloudflare/vitest-pool-workers` to `0.14.0`
- [ ] Update vitest config files if needed for breaking changes
- [ ] Run all tests to verify compatibility

### Phase 4: Verify
- [ ] `pnpm install` succeeds with no peer dep warnings
- [ ] `pnpm build` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] No `^` or `~` ranges remain in any package.json
- [ ] All shared deps use `catalog:` references

## Acceptance Criteria
- [ ] pnpm catalog configured in `pnpm-workspace.yaml` with all shared deps
- [ ] All dependency versions pinned (no `^` or `~` ranges)
- [ ] Vite version standardized (6.x) across all packages
- [ ] Vitest version standardized (4.x) across all packages
- [ ] All builds, tests, and checks pass

## References
- pnpm catalog docs: https://pnpm.io/catalogs
- Vite 6 migration: https://vite.dev/guide/migration
- Vitest 4 changelog
- Task ID: 01KN3ATD0MX6FH8WN18R41NB3Y
- Idea ID: 01KN2PRGW8PZP5TB3CN9B3CC1N
