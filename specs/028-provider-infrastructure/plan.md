# Implementation Plan: Provider Interface Modernization

**Branch**: `028-provider-infrastructure` | **Date**: 2026-03-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/028-provider-infrastructure/spec.md`

## Summary

Modernize the `packages/providers/` package into a clean cloud provider abstraction, migrate the API from flat Hetzner functions to the polymorphic `Provider` interface, and delete dead code. After this change, adding a new provider means implementing the `Provider` interface and passing a contract test suite.

## Technical Context

**Language/Version**: TypeScript 5.x
**Primary Dependencies**: None new (removes `execa` dependency from providers package)
**Storage**: N/A (no database changes)
**Testing**: Vitest (existing), contract test pattern (new)
**Target Platform**: Cloudflare Workers (no Node.js-only APIs)
**Project Type**: Monorepo — changes span `packages/providers/`, `apps/api/`, `packages/shared/`
**Performance Goals**: No performance impact — same HTTP calls, same behavior
**Constraints**: Workers-compatible (no `process.env`, no `child_process`, no `fs`)
**Scale/Scope**: ~10 files changed, ~3 files deleted, ~2 new files created

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source | PASS | No licensing changes |
| II. Infrastructure Stability | PASS | TDD approach, contract tests, >90% coverage target |
| III. Documentation Excellence | PASS | Docs updated in same PR |
| IV. Approachable Code | PASS | Simpler abstraction replaces dual-layer confusion |
| IX. Clean Code Architecture | PASS | `packages/` for shared, `apps/` for deployable — no circular deps |
| X. Simplicity & Clarity | PASS | Removes dead code, removes duplicate layers, single interface |
| XI. No Hardcoded Values | PASS | Timeout configurable via `providerFetch`, API URL is constant for Hetzner API |
| XII. Zero-to-Production | PASS | No new infrastructure, no new secrets, no deployment changes |
| XIII. Fail-Fast | PASS | `ProviderError` with structured diagnostics |

## Project Structure

### Documentation (this feature)

```text
specs/028-provider-infrastructure/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 (minimal — no unknowns)
├── data-model.md        # Phase 1 — type definitions
├── contracts/           # Phase 1 — Provider interface contract
│   └── provider-interface.md
└── checklists/
    └── requirements.md  # Quality checklist
```

### Source Code (repository root)

```text
packages/providers/
├── src/
│   ├── types.ts          # Provider, VMConfig, VMInstance, ProviderConfig, ProviderError, SizeConfig
│   ├── fetch.ts          # providerFetch (lifted from apps/api/src/services/fetch-timeout.ts)
│   ├── hetzner.ts        # HetznerProvider (modernized)
│   └── index.ts          # createProvider factory + re-exports
├── tests/
│   ├── unit/
│   │   ├── hetzner.test.ts    # HetznerProvider unit tests (already updated)
│   │   └── fetch.test.ts      # providerFetch tests
│   └── contract/
│       └── provider.contract.ts  # Reusable contract test suite
├── package.json
├── tsconfig.json
└── vitest.config.ts

apps/api/src/services/
├── nodes.ts              # MODIFIED: uses createProvider() (already updated)
├── hetzner.ts            # DELETED
└── fetch-timeout.ts      # DELETED (moved to packages/providers/src/fetch.ts)

apps/api/src/routes/
└── credentials.ts        # MODIFIED: uses provider.validateToken()
```

**Structure Decision**: Existing monorepo structure preserved. Changes are within `packages/providers/` (modernization) and `apps/api/` (migration + deletion).

## Complexity Tracking

No violations to justify — this change reduces complexity.
