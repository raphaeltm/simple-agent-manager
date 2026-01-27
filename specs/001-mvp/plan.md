# Implementation Plan: Cloud AI Coding Workspaces MVP

**Branch**: `001-mvp` | **Date**: 2026-01-24 | **Updated**: 2026-01-25 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-mvp/spec.md`

## Summary

A serverless platform for on-demand AI coding workspaces. Users can spin up cloud VMs with Claude Code pre-installed from any git repository (public or private via GitHub App), access them via a web-based interface (CloudCLI), and have them automatically terminate when idle.

**Key Changes (2026-01-25)**:
- Removed Anthropic API key requirement (users authenticate via `claude login`)
- Added GitHub App integration for private repository access with **read AND write** permissions
- Users can both clone and push to their private repositories
- Added Docker provider for local E2E testing

## Technical Context

**Language/Version**: TypeScript 5.x
**Primary Dependencies**: Hono (API), React + Vite (UI), Cloudflare Workers
**Storage**: Cloudflare KV (MVP), D1 (future multi-tenancy)
**Testing**: Vitest + Miniflare (unit/integration), Docker provider (E2E)
**Target Platform**: Cloudflare Workers (API), Cloudflare Pages (UI), Hetzner Cloud (VMs)
**Project Type**: Monorepo with pnpm workspaces + Turborepo
**Performance Goals**: Workspace creation <5 minutes, API response <200ms
**Constraints**: Zero cost when idle, single-user MVP
**Scale/Scope**: Single user, <10 concurrent workspaces

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ Pass | All core features OSS (MIT) |
| II. Infrastructure Stability | ✅ Pass | 90% coverage for critical paths, TDD required |
| III. Documentation Excellence | ✅ Pass | API docs, user guides, ADRs planned |
| IV. Approachable Code & UX | ✅ Pass | Simple control plane, clear error messages |
| V. Transparent Roadmap | ✅ Pass | ROADMAP.md + GitHub Issues |
| VI. Automated Quality Gates | ✅ Pass | CI/CD with lint, typecheck, test, coverage |
| VII. Inclusive Contribution | ✅ Pass | CONTRIBUTING.md, good-first-issues |
| VIII. AI-Friendly Repository | ✅ Pass | CLAUDE.md, AGENTS.md at root |
| IX. Clean Code Architecture | ✅ Pass | apps/ + packages/ monorepo structure |
| X. Simplicity & Clarity | ✅ Pass | Minimal abstractions, sensible defaults |

## Project Structure

### Documentation (this feature)

```text
specs/001-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 output - technology decisions
├── data-model.md        # Phase 1 output - entities and types
├── quickstart.md        # Phase 1 output - getting started guide
├── contracts/           # Phase 1 output - API contracts
│   └── api.md           # REST API specification
├── checklists/          # Validation checklists
│   └── requirements.md  # Spec quality checklist
└── tasks.md             # Phase 2 output (/speckit.tasks)
```

### Source Code (repository root)

```text
apps/
├── api/                  # Cloudflare Worker API (Hono)
│   ├── src/
│   │   ├── routes/       # API route handlers
│   │   ├── services/     # Business logic (workspace, dns, github)
│   │   └── lib/          # Utilities (auth, validation)
│   └── tests/
│       ├── unit/         # Pure logic tests
│       └── integration/  # Miniflare-based tests
└── web/                  # Control plane UI (React + Vite)
    ├── src/
    │   ├── components/   # UI components
    │   ├── pages/        # Page components
    │   └── services/     # API client
    └── tests/

packages/
├── shared/               # Shared types and utilities
│   ├── src/
│   │   ├── types.ts      # Workspace, GitHubConnection types
│   │   └── lib/          # id generation, validation
│   └── tests/
└── providers/            # Cloud provider abstraction
    ├── src/
    │   ├── types.ts      # Provider interface
    │   ├── hetzner.ts    # Hetzner Cloud implementation
    │   └── docker.ts     # Docker provider (local E2E)
    └── tests/

scripts/
└── vm/                   # VM-side scripts
    ├── cloud-init.sh     # VM setup script
    ├── idle-check.sh     # Idle detection
    └── setup-devcontainer.sh
```

**Structure Decision**: Monorepo with `apps/` for deployables and `packages/` for shared libraries. This follows the Constitution's Clean Code Architecture (Principle IX).

## Key Implementation Areas

### 1. GitHub App Integration (NEW - with Write Permissions)

**Purpose**: Enable access to private repositories with both clone AND push capabilities.

**Permissions Required**:
- `contents: read and write` - enables both cloning and pushing

**Flow**:
1. User clicks "Connect GitHub" in control plane
2. Redirect to GitHub App installation page
3. User selects repositories and installs (grants read+write access)
4. Callback stores installation ID in KV
5. On workspace creation, generate short-lived token with write permissions

**Files**:
- `apps/api/src/services/github.ts` - Token generation, installation management
- `apps/api/src/routes/github.ts` - OAuth endpoints
- `packages/shared/src/types.ts` - GitHubConnection type

**Secrets Required**:
- `GITHUB_APP_ID` - GitHub App ID
- `GITHUB_PRIVATE_KEY` - Private key (PKCS#8 format)

### 2. Claude Max Authentication (CHANGED)

**Purpose**: Users authenticate via interactive `claude login` instead of API key.

**Key Changes**:
- Remove `anthropicApiKey` from workspace creation request
- Remove API key validation from shared package
- Ensure VMs do NOT set `ANTHROPIC_API_KEY` environment variable
- Update cloud-init scripts to skip API key injection

**User Flow**:
1. Create workspace (no API key needed)
2. Open CloudCLI terminal
3. Run `claude login`
4. Complete browser OAuth flow
5. Claude Code authenticated

### 3. Docker Provider for E2E Testing (NEW)

**Purpose**: Enable end-to-end testing without cloud credentials.

**Architecture**:
- Docker container with `--privileged` for DinD
- Same cloud-init logic adapted for Docker
- Exposes CloudCLI on localhost

**Files**:
- `packages/providers/src/docker.ts` - Docker provider implementation
- `apps/api/tests/e2e/` - E2E test suites

**CI/CD**:
```yaml
services:
  dind:
    image: docker:dind
    options: --privileged
```

## Complexity Tracking

> No violations requiring justification. All implementation choices follow Constitution principles.

## Phase 1 Artifacts

| Artifact | Status | Description |
|----------|--------|-------------|
| [research.md](./research.md) | ✅ Complete | Technology decisions, GitHub App (with write), Docker provider |
| [data-model.md](./data-model.md) | ✅ Complete | Entities, validation, GitHubConnection with write permissions |
| [contracts/api.md](./contracts/api.md) | ✅ Complete | REST API with GitHub endpoints |
| [quickstart.md](./quickstart.md) | ✅ Complete | Getting started guide |

## Next Steps

1. Run `/speckit.tasks` to generate implementation tasks
2. Implement GitHub App integration (with contents: read and write)
3. Update existing validation to remove API key requirement
4. Implement Docker provider
5. Update cloud-init scripts for Claude Max auth

## References

- [Feature Spec](./spec.md)
- [Research Notes](./research.md)
- [Constitution](../../.specify/memory/constitution.md)
- [GitHub Apps Docs](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub App Permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [CloudCLI](https://github.com/siteboon/claudecodeui)
