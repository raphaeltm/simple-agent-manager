# Implementation Plan: Browser Terminal SaaS MVP

**Branch**: `003-browser-terminal-saas` | **Date**: 2026-01-26 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-browser-terminal-saas/spec.md`

## Summary

Multi-tenant SaaS platform for cloud-based AI coding workspaces. Users authenticate via GitHub, connect their Hetzner Cloud account, and create browser-accessible development environments. The platform consists of a Cloudflare Workers API, React web UI, and a Go-based VM Agent that runs on provisioned VMs to serve the terminal interface.

**Technical Approach**:
- Control plane runs on Cloudflare (Workers + Pages + D1 + KV + R2)
- BetterAuth handles GitHub OAuth + session management
- GitHub App provides repository access via installation tokens
- VM Agent is a single Go binary with embedded React/xterm.js UI
- JWT-based terminal authentication with JWKS validation

## Technical Context

**Language/Version**:
- Control Plane: TypeScript 5.x
- VM Agent: Go 1.22+
- Web UI: TypeScript 5.x

**Primary Dependencies**:
- API: Hono 4.x, BetterAuth, better-auth-cloudflare, Drizzle ORM, jose
- Web: React 18+, Vite 5.x, TailwindCSS, xterm.js
- VM Agent: github.com/creack/pty, github.com/gorilla/websocket, github.com/golang-jwt/jwt/v5

**Storage**:
- D1 (SQLite): Users, credentials, workspaces, GitHub installations
- KV: Sessions, rate limiting
- R2: VM Agent binaries

**Testing**: Vitest + Miniflare (API), Vitest (Web), go test (VM Agent)

**Target Platform**:
- API: Cloudflare Workers
- Web: Cloudflare Pages
- VM Agent: Linux amd64/arm64

**Project Type**: Monorepo (pnpm workspaces + Turborepo)

**Performance Goals**:
- Workspace provisioning: < 4 minutes
- Terminal connection: < 3 seconds
- Terminal latency: < 100ms
- Deploy to staging: < 3 minutes

**Constraints**:
- D1: 10GB max per database
- VM Agent: < 20MB uncompressed binary
- Self-contained: No external runtime dependencies for our artifacts
- cloud-init: 32KB limit

**Scale/Scope**:
- 10+ concurrent workspaces per user
- Multi-tenant with user-provided cloud credentials

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Open Source Sustainability | ✅ PASS | Core platform is OSS, no premium features in MVP |
| II. Infrastructure Stability | ✅ PASS | TDD required for critical paths (VM provisioning, DNS, auth) |
| III. Documentation Excellence | ✅ PASS | ADRs, guides, API docs planned |
| IV. Approachable Code | ✅ PASS | Functions <50 lines, files <400 lines |
| V. Transparent Roadmap | ✅ PASS | Spec in /specs/, tracked in ROADMAP.md |
| VI. Automated Quality Gates | ✅ PASS | Pre-commit, CI, branch protection |
| VII. Inclusive Contribution | ✅ PASS | CONTRIBUTING.md, good-first-issues planned |
| VIII. AI-Friendly Repository | ✅ PASS | CLAUDE.md, AGENTS.md maintained |
| IX. Clean Code Architecture | ✅ PASS | Monorepo with apps/, packages/, clear boundaries |
| X. Simplicity & Clarity | ✅ PASS | No premature abstractions, YAGNI enforced |
| Multi-Tenant Architecture | ✅ PASS | Users bring own cloud, encrypted credentials |
| Authentication Architecture | ✅ PASS | BetterAuth + GitHub OAuth, JWT terminal auth |
| VM Agent Guidelines | ✅ PASS | Single Go binary, embedded UI, creack/pty |
| Self-Contained Deployment | ✅ PASS | Control plane serves VM Agent, no GitHub runtime dep |
| Cloudflare-First Development | ✅ PASS | Easy deploy/teardown, iterate on staging |

**Gate Status**: ✅ PASS - All principles satisfied. Proceed to Phase 0.

## Project Structure

### Documentation (this feature)

```text
specs/003-browser-terminal-saas/
├── plan.md              # This file
├── spec.md              # Feature specification
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output (OpenAPI specs)
│   ├── api.yaml         # Control plane API
│   └── agent.yaml       # VM Agent API
├── checklists/          # Quality checklists
│   └── requirements.md  # Spec validation checklist
└── tasks.md             # Phase 2 output (from /speckit.tasks)
```

### Source Code (repository root)

```text
apps/
├── api/                          # Cloudflare Worker (Hono)
│   ├── src/
│   │   ├── index.ts              # Entry point, Hono app
│   │   ├── auth.ts               # BetterAuth configuration
│   │   ├── routes/
│   │   │   ├── auth.ts           # Auth routes (BetterAuth handler)
│   │   │   ├── credentials.ts    # Hetzner token management
│   │   │   ├── github.ts         # GitHub App installations, repos
│   │   │   ├── workspaces.ts     # Workspace CRUD
│   │   │   ├── terminal.ts       # JWT token generation
│   │   │   └── agent.ts          # VM Agent binary download
│   │   ├── services/
│   │   │   ├── hetzner.ts        # Hetzner Cloud API client
│   │   │   ├── dns.ts            # Cloudflare DNS management
│   │   │   ├── github-app.ts     # GitHub App token generation
│   │   │   ├── encryption.ts     # AES-GCM credential encryption
│   │   │   └── jwt.ts            # JWT signing, JWKS endpoint
│   │   ├── db/
│   │   │   ├── schema.ts         # Drizzle schema
│   │   │   └── migrations/       # D1 migrations
│   │   └── middleware/
│   │       ├── auth.ts           # Session validation
│   │       └── error.ts          # Error handling
│   ├── wrangler.toml
│   ├── vitest.config.ts
│   └── package.json
│
└── web/                          # Cloudflare Pages (React)
    ├── src/
    │   ├── main.tsx              # Entry point
    │   ├── App.tsx               # Router, auth provider
    │   ├── pages/
    │   │   ├── Landing.tsx       # Marketing/sign-in
    │   │   ├── Dashboard.tsx     # Workspace list
    │   │   ├── Settings.tsx      # Hetzner token, GitHub App
    │   │   ├── CreateWorkspace.tsx
    │   │   └── Workspace.tsx     # Single workspace view
    │   ├── components/
    │   │   ├── WorkspaceCard.tsx
    │   │   ├── RepoSelector.tsx
    │   │   └── StatusBadge.tsx
    │   └── lib/
    │       ├── auth.ts           # BetterAuth client
    │       └── api.ts            # API client
    ├── vite.config.ts
    └── package.json

packages/
├── shared/                       # Shared TypeScript types
│   ├── src/
│   │   ├── types.ts              # User, Workspace, Credential types
│   │   └── constants.ts          # Status enums, defaults
│   └── package.json
│
├── cloud-init/                   # Cloud-init template generation
│   ├── src/
│   │   ├── template.ts           # Base template
│   │   └── generate.ts           # Generate with variables
│   └── package.json
│
└── vm-agent/                     # Go binary with embedded UI
    ├── main.go                   # Entry point
    ├── go.mod
    ├── embed.go                  # //go:embed ui/dist/*
    ├── internal/
    │   ├── auth/
    │   │   ├── jwt.go            # JWT validation via JWKS
    │   │   └── session.go        # Session cookie management
    │   ├── pty/
    │   │   ├── manager.go        # PTY session manager
    │   │   └── session.go        # Individual PTY session
    │   ├── server/
    │   │   ├── server.go         # HTTP server
    │   │   ├── routes.go         # Route handlers
    │   │   └── websocket.go      # Terminal WebSocket
    │   ├── idle/
    │   │   └── detector.go       # Idle detection, shutdown trigger
    │   └── config/
    │       └── config.go         # Environment configuration
    ├── ui/                       # Embedded React UI
    │   ├── src/
    │   │   ├── App.tsx
    │   │   ├── main.tsx
    │   │   └── components/
    │   │       ├── Terminal.tsx  # xterm.js wrapper
    │   │       └── StatusBar.tsx
    │   ├── vite.config.ts
    │   └── package.json
    ├── Makefile                  # Build commands
    └── .goreleaser.yml           # Release automation

scripts/
├── deploy.ts                     # Deploy all to prod
├── deploy-staging.ts             # Deploy all to staging
├── teardown.ts                   # Destroy environment
├── setup.ts                      # First-time setup wizard
└── generate-keys.ts              # Generate JWT/encryption keys

docs/
├── guides/
│   ├── getting-started.md
│   └── self-hosting.md
└── adr/
    └── 001-github-app-over-oauth.md
```

**Structure Decision**: Monorepo with apps/ for deployable services (api, web) and packages/ for shared libraries (shared, cloud-init, vm-agent). The VM Agent is a Go package that builds to a binary, not a TypeScript package.

## Complexity Tracking

> No Constitution Check violations - this section is empty.

## Research Topics (Phase 0)

The following topics require research before Phase 1 design:

1. **BetterAuth + Cloudflare Configuration**
   - better-auth-cloudflare setup with Hono
   - GitHub OAuth provider configuration
   - Session storage in KV

2. **GitHub App Implementation**
   - App registration and webhook setup
   - Installation token generation via API
   - Repository listing permissions

3. **Hetzner Cloud API Patterns**
   - Server creation with cloud-init
   - Error handling and rate limits
   - Server deletion cleanup

4. **Cloudflare DNS API**
   - Dynamic subdomain creation
   - A record management
   - Proxied vs direct records

5. **Go PTY and WebSocket Patterns**
   - creack/pty usage for shell spawning
   - gorilla/websocket binary frame handling
   - Terminal resize protocol

6. **JWT/JWKS in Workers and Go**
   - jose library for RS256 signing
   - JWKS endpoint format
   - Go JWT validation with JWKS

7. **AES-GCM in Web Crypto API**
   - Encryption with Workers crypto
   - IV generation and storage
   - Key derivation patterns

8. **R2 Binary Storage**
   - Uploading VM Agent binaries
   - Serving binaries via Worker
   - Cache headers

## Phase 0 Output

See: [research.md](./research.md)

## Phase 1 Outputs

- [data-model.md](./data-model.md) - Database schema and entity relationships
- [contracts/api.yaml](./contracts/api.yaml) - Control plane OpenAPI spec
- [contracts/agent.yaml](./contracts/agent.yaml) - VM Agent API spec
- [quickstart.md](./quickstart.md) - Developer getting started guide

### Post-Design Constitution Re-Check

*Verified after Phase 1 design completion (2026-01-26)*

| Principle | Status | Phase 1 Validation |
|-----------|--------|-------------------|
| I. Open Source Sustainability | ✅ PASS | No premium features in data model or API |
| II. Infrastructure Stability | ✅ PASS | TDD structure in place; test files planned per module |
| III. Documentation Excellence | ✅ PASS | quickstart.md, API contracts, data-model.md complete |
| IV. Approachable Code | ✅ PASS | Clear route/service separation, small focused files |
| V. Transparent Roadmap | ✅ PASS | Full spec/plan/tasks workflow in /specs/ |
| VI. Automated Quality Gates | ✅ PASS | Vitest + go test in project structure |
| VII. Inclusive Contribution | ✅ PASS | quickstart.md lowers barrier to entry |
| VIII. AI-Friendly Repository | ✅ PASS | CLAUDE.md updated with new technologies |
| IX. Clean Code Architecture | ✅ PASS | apps/api, apps/web, packages/* separation in data model |
| X. Simplicity & Clarity | ✅ PASS | 4 core entities, minimal schema |
| Multi-Tenant Architecture | ✅ PASS | Encrypted credentials, user-owned VMs in data model |
| Authentication Architecture | ✅ PASS | BetterAuth + JWKS in API contracts |
| VM Agent Guidelines | ✅ PASS | Go PTY patterns in research, embedded UI in contracts |
| Self-Contained Deployment | ✅ PASS | /api/agent/download endpoint in API contract |
| Cloudflare-First Development | ✅ PASS | Full deploy/teardown in quickstart.md |

**Post-Design Gate Status**: ✅ PASS - All principles validated in design artifacts.

## Phase 2 Output

See: [tasks.md](./tasks.md) (generated by `/speckit.tasks`)
