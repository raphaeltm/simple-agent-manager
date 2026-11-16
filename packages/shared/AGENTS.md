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
| `src/system-ids.ts` | Well-known ids of migration-seeded system rows |

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

<!-- BEGIN GENERATED RULE INDEX (pnpm quality:agent-context-budget --write) -->

## Rules for this directory

Read the rules whose scope covers the files you will change before editing. Claude Code
loads them by itself on file access; other harnesses must open them.

- `.claude/rules/24-no-duplicate-ui-controls.md`: No Duplicate Implementations
- `.claude/rules/28-credential-resolution-fallback-tests.md`: Credential Resolution, Fallback, and Rotation Safety Tests
- `.claude/rules/41-credential-snapshot-resilience.md`: Credential Snapshot/Resolution Must Tolerate a Single Bad Row
- `.claude/rules/51-vm-agent-no-host-mime-dependency.md`: VM Agent Behavior Must Not Depend on Host-Provided MIME/OS Databases
- `.claude/rules/52-model-catalog-lifecycle.md`: Model Catalog Lifecycle (Adding and Retiring Provider Models)
- `.claude/rules/73-optional-struct-fields-must-not-overwrite-on-absence.md`: A Zero-Valued Optional Field Must Not Overwrite Existing State
- `.claude/rules/79-new-enum-values-audit-every-denylist.md`: A New Value in a Shared Status Enum Must Audit Every Denylist Over That Enum
- `.claude/rules/82-typed-cards-every-harness.md`: A Typed Chat Card Must Render for Every Agent Harness

<!-- END GENERATED RULE INDEX -->
