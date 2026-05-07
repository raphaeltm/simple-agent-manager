# Shared Package (packages/shared)

## Purpose

Shared TypeScript types, constants, and utilities used across the entire monorepo (API Worker, web app, cloud-init, providers). This is the foundation dependency — every other package imports from here.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Barrel export — all public types and constants |
| `src/types/` | Domain-specific type files (workspace, project, task, session, etc.) |
| `src/constants/` | Configurable defaults, registries, enums (vm-sizes, providers, scaling) |
| `src/agents.ts` | Agent type definitions and configuration |
| `src/model-catalog.ts` | LLM model catalog and metadata |
| `src/vm-agent-contract.ts` | VM agent HTTP API contract types |
| `src/trial.ts` | Trial orchestrator types |

## Commands

```bash
pnpm --filter @simple-agent-manager/shared build       # Compile TypeScript
pnpm --filter @simple-agent-manager/shared test        # Run Vitest
pnpm --filter @simple-agent-manager/shared typecheck   # Type check only
pnpm --filter @simple-agent-manager/shared lint        # ESLint
```

## Conventions

- **Types go in `src/types/<domain>.ts`** — one file per domain (workspace, task, project, etc.)
- **Constants go in `src/constants/<domain>.ts`** — registries, defaults, enums
- **All public exports must be re-exported from `src/index.ts`** — consumers import from the package root
- **Use `import type` for type-only imports** (enforced by ESLint)
- **Configurable values use env-var resolution patterns**: `env.VAR_NAME ?? DEFAULT_CONSTANT`
- **Validation uses Valibot** (preferred over Zod for new code)

## Gotchas

- This package MUST be built before any downstream consumer (`pnpm --filter @simple-agent-manager/shared build`)
- Adding a new type file requires adding the re-export to `src/index.ts` or it won't be visible
- Constants that represent configurable limits must have env-var override support (Constitution Principle XI)
- The `src/types/index.ts` re-exports all type files — keep it updated when adding new files
