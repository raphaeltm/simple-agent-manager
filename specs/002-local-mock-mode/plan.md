# Implementation Plan: Local Mock Mode

**Branch**: `002-local-mock-mode` | **Date**: 2025-01-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-local-mock-mode/spec.md`

## Summary

Enable local development of the control plane without cloud infrastructure by:
1. Creating a `DevcontainerProvider` that uses the native `devcontainer` CLI
2. Creating a `MockDNSService` that stores records in memory
3. Adding a `pnpm dev:mock` command with environment-based provider selection
4. Deleting the broken Docker-in-Docker implementation

## Technical Context

**Language/Version**: TypeScript 5.x
**Primary Dependencies**: @devcontainers/cli (exec'd via child process), Hono (API), React + Vite (UI)
**Storage**: In-memory (Map) for mock mode; no persistent storage
**Testing**: Vitest + Miniflare (unit/integration)
**Target Platform**: Local development (Node.js runtime for devcontainer provider)
**Project Type**: Monorepo (pnpm workspaces + Turborepo)
**Performance Goals**: Workspace creation <2 minutes (per spec SC-002)
**Constraints**: Single workspace at a time (per spec FR-012); Docker must be running
**Scale/Scope**: Single developer local testing; not for production use

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ Pass | Mock mode is OSS tooling for developers |
| II. Infrastructure Stability | ✅ Pass | This feature ENABLES local testing per Principle II requirements |
| III. Documentation Excellence | ✅ Pass | Will document in quickstart.md |
| IV. Approachable Code & UX | ✅ Pass | Error messages for Docker/CLI missing defined in spec |
| V. Transparent Roadmap | ✅ Pass | Feature tracked in specs/ |
| VI. Automated Quality Gates | ✅ Pass | Tests will be added for new providers |
| VII. Inclusive Contribution | ✅ Pass | Lowers barrier - no cloud credentials needed |
| VIII. AI-Friendly Repository | ✅ Pass | Following existing patterns |
| IX. Clean Code Architecture | ✅ Pass | DevcontainerProvider in packages/providers/, following interface |
| X. Simplicity & Clarity | ✅ Pass | Single workspace limit is KISS; reusing existing Provider interface |

**No violations.** This feature improves Constitution compliance by enabling local testing.

## Project Structure

### Documentation (this feature)

```text
specs/002-local-mock-mode/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (no new endpoints - reusing existing)
└── tasks.md             # Phase 2 output (/speckit.tasks command)
```

### Source Code (repository root)

```text
packages/providers/
├── src/
│   ├── index.ts              # MODIFY: Update factory, exports
│   ├── types.ts              # No changes (reuse Provider interface)
│   ├── hetzner.ts            # No changes
│   ├── devcontainer.ts       # CREATE: DevcontainerProvider
│   └── docker.ts             # DELETE
└── tests/
    └── devcontainer.test.ts  # CREATE: Provider tests

apps/api/
├── src/
│   ├── services/
│   │   ├── dns.ts            # MODIFY: Extract interface
│   │   ├── mock-dns.ts       # CREATE: MockDNSService
│   │   └── workspace.ts      # MODIFY: Use injected provider/dns
│   └── index.ts              # MODIFY: Provider selection
├── wrangler.toml             # MODIFY: Add [env.mock] section
└── tests/
    └── mock-dns.test.ts      # CREATE: DNS mock tests

scripts/
├── docker/                   # DELETE entire directory
└── vm/                       # No changes

# Root level
├── .env.mock                 # CREATE: Mock environment template
└── package.json              # MODIFY: Add dev:mock script
```

**Structure Decision**: Following existing monorepo structure. DevcontainerProvider goes in `packages/providers/` alongside HetznerProvider. MockDNSService goes in `apps/api/src/services/` alongside DNSService since it's API-specific.

## Complexity Tracking

No violations to justify - the design follows existing patterns without adding complexity.
