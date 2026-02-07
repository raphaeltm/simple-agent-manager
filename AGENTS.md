# Agent Instructions

This document provides detailed instructions for AI coding agents working on this project.

## Architecture Overview

### Stateless Design

The MVP uses a stateless architecture where workspace state is derived from:

1. **Hetzner server labels** - Metadata stored with VM
2. **Cloudflare DNS records** - Existence implies active workspace

No database is required for the MVP.

### Package Dependencies

```
@simple-agent-manager/shared
    ↑
@simple-agent-manager/providers
    ↑
@simple-agent-manager/api
    ↑
@simple-agent-manager/web
```

Build order matters: shared → providers → api/web

## Development Guidelines

### No Legacy / Dead Code

- This project is pre-production. Do not keep "legacy" code paths that are not used.
- If code, files, routes, scripts, or configs are no longer referenced by the active architecture, remove them in the same change.
- When replacing an implementation, update all related docs and instructions to point only to the current path.

### Adding New Features

1. Check if types need to be added to `packages/shared`
2. If provider-related, add to `packages/providers`
3. API endpoints go in `apps/api/src/routes/`
4. UI components go in `apps/web/src/components/`

### Writing Tests

- Unit tests: `tests/unit/` in each package
- Integration tests: `apps/api/tests/integration/`
- Use Miniflare for Worker integration tests
- Critical paths require >90% coverage

### Documentation & File Naming

When creating documentation or implementation notes:

- **Location**: Never put documentation files in package roots
  - Ephemeral working notes (implementation summaries, checklists): `docs/notes/`
  - Permanent documentation (guides, architecture): `docs/`
  - Feature specs and design docs: `specs/<feature>/`
- **Naming**: Use kebab-case for all markdown files
  - Good: `phase8-implementation-summary.md`, `idle-detection-design.md`
  - Bad: `PHASE8_IMPLEMENTATION_SUMMARY.md`, `IdleDetectionDesign.md`
- **Exceptions**: Only `README.md`, `LICENSE`, `CONTRIBUTING.md`, `CHANGELOG.md` use UPPER_CASE

### Error Handling

All API errors should follow this format:

```typescript
{
  error: "error_code",
  message: "Human-readable description"
}
```

### Environment Variables

Workers secrets are set via:

```bash
wrangler secret put SECRET_NAME
```

Local development uses `.dev.vars`:

```
CF_API_TOKEN=...
ENCRYPTION_KEY=...
```

**Note**: Hetzner tokens are NOT platform secrets. Users provide their own tokens through the Settings UI, stored encrypted per-user in the database. See `docs/architecture/credential-security.md`.

## Code Patterns

### Provider Implementation

```typescript
import { Provider, VMConfig, VMInstance } from './types';

export class MyProvider implements Provider {
  async createVM(config: VMConfig): Promise<VMInstance> {
    // Implementation
  }
}
```

### Hono Route Handler

```typescript
import { Hono } from 'hono';

const app = new Hono();

app.post('/endpoint', async (c) => {
  const body = await c.req.json();
  // Validate and process
  return c.json({ result: 'success' }, 201);
});
```

### React Component

```typescript
import { FC } from 'react';

interface Props {
  workspace: Workspace;
}

export const WorkspaceCard: FC<Props> = ({ workspace }) => {
  return (
    <div className="workspace-card">
      {/* Implementation */}
    </div>
  );
};
```

## Common Tasks

### Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`
2. Register in `apps/api/src/index.ts`
3. Add integration tests
4. Update API contract in `specs/001-mvp/contracts/api.md`

### Adding a New Provider

1. Create provider class in `packages/providers/src/`
2. Implement `Provider` interface
3. Export from `packages/providers/src/index.ts`
4. Add unit tests

### Modifying Cloud-Init

1. Edit `packages/cloud-init/src/template.ts`
2. Update variable wiring in `packages/cloud-init/src/generate.ts` when needed
3. Test cloud-init generation through the workspace provisioning flow in `apps/api/src/routes/workspaces.ts`

## Troubleshooting

### Build Errors

Run builds in dependency order:

```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

### Test Failures

Check if Miniflare bindings are configured in `vitest.config.ts`.

### Type Errors

Run `pnpm typecheck` from root to see all issues.


---

## Consolidated From CLAUDE.md

# Simple Agent Manager (SAM)

A serverless platform to spin up AI coding agent environments on-demand with zero ongoing cost.

## CRITICAL: Request Validation (NON-NEGOTIABLE)

**After completing ANY task, you MUST re-read the user's original request and verify your work fully addresses it.**

1. **MUST** scroll back to the user's last message that initiated the task
2. **MUST** compare what was requested vs. what was delivered
3. **MUST** explicitly confirm each requested item was addressed
4. **MUST** acknowledge any items that were deferred or handled differently than requested
5. **MUST NOT** mark work as complete until this validation passes

This prevents scope drift and ensures the user gets exactly what they asked for.

---

## CRITICAL: Constitution Validation (NON-NEGOTIABLE)

**ALL changes MUST be validated against the project constitution (`.specify/memory/constitution.md`) before completion.**

1. **MUST** read and understand all constitution principles before making changes
2. **MUST** validate EVERY change against Principle XI (No Hardcoded Values):
   - NO hardcoded URLs - derive from environment variables (e.g., `BASE_DOMAIN`)
   - NO hardcoded timeouts - use configurable env vars with defaults
   - NO hardcoded limits - all limits must be configurable
   - NO hardcoded identifiers - issuers, audiences, key IDs must be dynamic
3. **MUST** fix any violations before marking work as complete
4. **MUST** use sequential thinking to verify compliance

### Quick Compliance Check

Before committing any business logic changes, verify:
- [ ] All URLs derived from `BASE_DOMAIN` or similar env vars
- [ ] All timeouts have `DEFAULT_*` constants and env var overrides
- [ ] All limits are configurable via environment
- [ ] No magic strings that should be configuration

---

## CRITICAL: Mobile-First UI Requirements (NON-NEGOTIABLE)

**ALL UI changes MUST be tested for mobile usability before deployment.**

1. **MUST** ensure login/primary CTAs are prominent and have min 56px touch targets
2. **MUST** use responsive text sizes (mobile → tablet → desktop)
3. **MUST** start with single-column layouts on mobile
4. **MUST** test on mobile viewport before deploying
5. **MUST** follow `docs/guides/mobile-ux-guidelines.md`

### Quick Mobile Check

Before deploying any UI changes:
- [ ] Login button visible and large (min 56px height)
- [ ] Text readable without zooming (responsive sizing)
- [ ] Grid layouts collapse to single column on mobile
- [ ] Tested in Chrome DevTools mobile view

---

## CRITICAL: Environment Variable Naming (NON-NEGOTIABLE)

**GitHub secrets and Cloudflare Worker secrets use DIFFERENT naming conventions. Confusing them causes deployment failures.**

### The Two Naming Conventions

| Context | Prefix | Example | Where Used |
|---------|--------|---------|------------|
| **GitHub Environment** | `GH_` | `GH_CLIENT_ID` | GitHub Settings → Environments → production |
| **Cloudflare Worker** | `GITHUB_` | `GITHUB_CLIENT_ID` | Worker runtime, local `.env` files |

### Why Different Names?

GitHub Actions reserves `GITHUB_*` environment variables for its own use. Using `GITHUB_CLIENT_ID` as a GitHub secret would conflict. So we use `GH_*` in GitHub, and the deployment script maps them to `GITHUB_*` Worker secrets.

### The Mapping (done by `configure-secrets.sh`)

```
GitHub Secret          →  Cloudflare Worker Secret
─────────────────────────────────────────────────
GH_CLIENT_ID           →  GITHUB_CLIENT_ID
GH_CLIENT_SECRET       →  GITHUB_CLIENT_SECRET
GH_APP_ID              →  GITHUB_APP_ID
GH_APP_PRIVATE_KEY     →  GITHUB_APP_PRIVATE_KEY
GH_APP_SLUG            →  GITHUB_APP_SLUG
```

### Documentation Rules

When documenting environment variables:
1. **GitHub Environment config** → Use `GH_*` prefix
2. **Cloudflare Worker secrets** → Use `GITHUB_*` prefix
3. **Local `.env` files** → Use `GITHUB_*` prefix (same as Worker)
4. **ALWAYS** specify which context you're documenting
5. **NEVER** mix prefixes in the same table without explanation

### Quick Reference

- **User configuring GitHub**: Tell them to use `GH_CLIENT_ID`
- **Code reading from env**: Use `env.GITHUB_CLIENT_ID`
- **Local development**: Use `GITHUB_CLIENT_ID` in `.env`

---

## CRITICAL: Architecture Research Requirements

**Before making ANY changes related to architecture, secrets, credentials, data models, or security:**

1. **MUST** research relevant architecture documentation:
   - `docs/architecture/` - Core architecture decisions
   - `docs/adr/` - Architecture Decision Records
   - `specs/` - Feature specifications with data models
   - `.specify/memory/constitution.md` - Project principles (especially Principle XI)

2. **MUST** use sequential thinking to:
   - Understand the existing architecture
   - Identify how your change fits (or conflicts)
   - Consider security implications
   - **Validate against constitution principles**
   - Document your reasoning

3. **MUST** provide explicit justification for any architecture-related changes

### Key Architecture Documents

| Document | Contents |
|----------|----------|
| `docs/architecture/credential-security.md` | BYOC model, encryption, user credentials |
| `docs/architecture/secrets-taxonomy.md` | Platform secrets vs user credentials |
| `docs/adr/002-stateless-architecture.md` | Stateless design principles |
| `.specify/memory/constitution.md` | Core principles and rules |

### Architecture Principles (Quick Reference)

1. **Bring-Your-Own-Cloud (BYOC)**: Users provide their own Hetzner tokens. The platform does NOT have cloud provider credentials.
2. **User credentials are encrypted per-user** in the database, NOT stored as environment variables or Worker secrets.
3. **Platform secrets** (ENCRYPTION_KEY, JWT keys, CF_API_TOKEN) are Cloudflare Worker secrets set during deployment.

---

## CRITICAL: Business Logic Research Requirements

**Before making ANY changes related to features, workflows, state machines, validation rules, or user-facing behavior:**

1. **MUST** research relevant feature specifications:
   - `specs/` - Feature specs with user stories, requirements, acceptance criteria
   - `specs/*/data-model.md` - State machines, entity relationships, constraints
   - `apps/api/src/db/schema.ts` - Current database schema and constraints
   - `apps/api/src/routes/` - Existing API behavior and validation

2. **MUST** use sequential thinking to:
   - Understand existing business rules and why they exist
   - Identify edge cases and error scenarios
   - Consider impact on existing features
   - Document your reasoning

3. **MUST** provide explicit justification for any business logic changes

### Key Business Logic Documents

| Document | Contents |
|----------|----------|
| `specs/003-browser-terminal-saas/spec.md` | Core SaaS features, user stories |
| `specs/003-browser-terminal-saas/data-model.md` | Entity relationships, state machines |
| `specs/004-mvp-hardening/spec.md` | Security hardening, access control |
| `specs/004-mvp-hardening/data-model.md` | Bootstrap tokens, ownership validation |

### Business Logic Principles (Quick Reference)

1. **Workspace Lifecycle**: pending → creating → running → stopping → stopped (see data-model.md for state machine)
2. **Idle Detection**: Configurable timeout (default 30 minutes via `IDLE_TIMEOUT_SECONDS`), managed by VM Agent with PTY activity detection
3. **Ownership Validation**: All workspace operations MUST verify `user_id` matches authenticated user
4. **Bootstrap Tokens**: One-time use, 5-minute expiry, cryptographically random

---

## CRITICAL: Agent Preflight Behavior (NON-NEGOTIABLE)

**Before writing ANY code, agents MUST complete preflight behavior checks.**

This policy is defined in `docs/guides/agent-preflight-behavior.md` and enforced through PR evidence checks in CI.

### Mandatory Preflight Steps (Before Code Edits)

1. **MUST** classify the change using one or more classes:
   - `external-api-change`, `cross-component-change`, `business-logic-change`, `public-surface-change`
   - `docs-sync-change`, `security-sensitive-change`, `ui-change`, `infra-change`
2. **MUST** gather class-required context before editing files
3. **MUST** record assumptions and impact analysis before implementation
4. **MUST** plan documentation/spec updates when interfaces or behavior change
5. **MUST** run constitution alignment checks relevant to the change

### Required Behavioral Rules

- **Up-to-date docs first**: For `external-api-change`, use Context7 when available. If unavailable, use official primary documentation and record what was used.
- **Cross-component impact first**: For `cross-component-change`, map dependencies and affected components before edits.
- **Code usage analysis first**: For business logic/contract changes, inspect existing usage and edge cases before implementation.
- **Docs sync by default**: If behavior or interfaces change, update docs/specs in the same PR or explicitly justify deferral.

### Speckit and Non-Speckit Enforcement

- **Non-Speckit tasks**: Complete full preflight at task start before any code edits.
- **Speckit tasks**: Complete preflight before `/speckit.plan`, and re-run preflight before `/speckit.implement`.

### PR Evidence Requirement

All AI-authored PRs MUST include preflight evidence using the block in `.github/pull_request_template.md`.
CI validates this evidence on pull requests.

---

## Project Overview

This is a monorepo containing a Cloudflare-based platform for managing ephemeral Claude Code workspaces. Users can create cloud VMs with Claude Code pre-installed from any git repository, access them via a web-based interface, and have them automatically terminate when idle.

## Tech Stack

- **Runtime**: Cloudflare Workers (API), Cloudflare Pages (UI)
- **Language**: TypeScript 5.x
- **Framework**: Hono (API), React + Vite (UI)
- **Cloud Provider**: Hetzner Cloud (VMs)
- **DNS**: Cloudflare DNS API
- **Testing**: Vitest + Miniflare
- **Monorepo**: pnpm workspaces + Turborepo

## Repository Structure

```
apps/
├── api/          # Cloudflare Worker API (Hono)
└── web/          # Control plane UI (React + Vite)

packages/
├── shared/       # Shared types and utilities
├── providers/    # Cloud provider abstraction (Hetzner)
├── terminal/     # Shared terminal component (@simple-agent-manager/terminal)
├── cloud-init/   # Cloud-init template generator
└── vm-agent/     # Go VM agent (PTY, WebSocket, idle detection)

scripts/
└── vm/           # VM-side scripts (cloud-init, idle detection)

specs/            # Feature specifications
docs/             # Documentation
```

## Development Approach

**This project uses a Cloudflare-first development approach.** Per the constitution:

> "No complex local testing setups. Iterate directly on Cloudflare infrastructure."

### Recommended Workflow

1. **Make changes locally** - Use your IDE, run lint/typecheck
2. **Deploy to staging** - Via GitHub Actions or `pnpm deploy:setup --environment staging`
3. **Test on Cloudflare** - Real D1, real KV, real Workers
4. **Merge to main** - Triggers production deployment

### Local Dev Limitations (NOT Recommended for Testing)

Running `pnpm dev` starts local emulators but has significant limitations:
- No real GitHub OAuth (callbacks won't work)
- No real DNS (workspace URLs won't resolve)
- No real VMs (workspaces can't be created)
- D1/KV emulation may differ from production

**For any meaningful testing, deploy to staging.**

See `docs/guides/local-development.md` for details.

---

## Common Commands

```bash
# Install dependencies
pnpm install

# Run development servers (LIMITED - see above)
pnpm dev

# Run tests
pnpm test

# Build all packages
pnpm build

# Type check
pnpm typecheck

# Lint and format
pnpm lint
pnpm format
```

## Deployment

**Continuous Deployment:** Merge to `main` automatically deploys to production.

### Configuration (GitHub Environment)

All configuration lives in **GitHub Settings → Environments → production**:

| Type | Name | Required |
|------|------|----------|
| Variable | `BASE_DOMAIN` | Yes |
| Variable | `RESOURCE_PREFIX` | No (default: `sam`) |
| Variable | `PULUMI_STATE_BUCKET` | No (default: `sam-pulumi-state`) |
| Secret | `CF_API_TOKEN` | Yes |
| Secret | `CF_ACCOUNT_ID` | Yes |
| Secret | `CF_ZONE_ID` | Yes |
| Secret | `R2_ACCESS_KEY_ID` | Yes |
| Secret | `R2_SECRET_ACCESS_KEY` | Yes |
| Secret | `PULUMI_CONFIG_PASSPHRASE` | Yes |
| Secret | `GH_CLIENT_ID` | Yes |
| Secret | `GH_CLIENT_SECRET` | Yes |
| Secret | `GH_APP_ID` | Yes |
| Secret | `GH_APP_PRIVATE_KEY` | Yes |
| Secret | `GH_APP_SLUG` | Yes |
| Secret | `ENCRYPTION_KEY` | No (auto-generated) |
| Secret | `JWT_PRIVATE_KEY` | No (auto-generated) |
| Secret | `JWT_PUBLIC_KEY` | No (auto-generated) |

### GitHub Actions Workflows

- **CI** (`ci.yml`): Runs on all pushes/PRs - lint, typecheck, test, build
- **Deploy** (`deploy.yml`): Runs on push to main - full Pulumi + Wrangler deployment
- **Teardown** (`teardown.yml`): Manual only - destroys all resources (type "DELETE" to confirm)

### Manual Deployment

You can also trigger deployment manually via GitHub Actions → Deploy → Run workflow.

## Key Concepts

- **Workspace**: An AI coding environment (VM + devcontainer + Claude Code)
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **CloudCLI**: Web-based Claude Code interface (file explorer + terminal)
- **Idle Detection**: VMs self-terminate after inactivity (default 30 minutes, configurable via `IDLE_TIMEOUT_SECONDS`)

## API Endpoints

### Workspace Management
- `POST /api/workspaces` - Create workspace
- `GET /api/workspaces` - List user's workspaces
- `GET /api/workspaces/:id` - Get workspace details
- `POST /api/workspaces/:id/stop` - Stop a running workspace
- `POST /api/workspaces/:id/restart` - Restart a workspace
- `DELETE /api/workspaces/:id` - Delete a workspace (permanently removes it)
- `GET /api/workspaces/:id/ready` - Check workspace readiness

### VM Communication
- `POST /api/workspaces/:id/heartbeat` - VM heartbeat with idle detection
- `POST /api/bootstrap/:token` - Redeem one-time bootstrap token (VM startup)
- `POST /api/agent/ready` - VM agent ready callback
- `POST /api/agent/activity` - VM agent activity report

### Terminal Access
- `POST /api/terminal/token` - Get terminal WebSocket token (workspaceId in request body)

### Authentication (BetterAuth)
- `POST /api/auth/sign-in/social` - GitHub OAuth login
- `GET /api/auth/session` - Get current session
- `POST /api/auth/sign-out` - Sign out

### Credentials
- `GET /api/credentials` - Get user's cloud provider credentials (encrypted)
- `PUT /api/credentials` - Save cloud provider credentials

### GitHub Integration
- `GET /api/github/installations` - List user's GitHub App installations
- `GET /api/github/repos` - List accessible repositories

## Environment Variables

### Platform Secrets (Cloudflare Worker Secrets)

These are the secrets the **Worker code reads at runtime**. They use the `GITHUB_*` prefix.

> **Note**: In GitHub Environment config, use `GH_*` prefix instead. See [Environment Variable Naming](#critical-environment-variable-naming-non-negotiable) for the mapping.

| Secret | Purpose | Required |
|--------|---------|----------|
| `ENCRYPTION_KEY` | Encrypt user credentials | Yes |
| `JWT_PRIVATE_KEY` | Sign auth tokens | Yes |
| `JWT_PUBLIC_KEY` | Verify auth tokens | Yes |
| `CF_API_TOKEN` | DNS operations | Yes |
| `CF_ZONE_ID` | DNS zone | Yes |
| `GITHUB_CLIENT_ID` | OAuth login | Yes |
| `GITHUB_CLIENT_SECRET` | OAuth login | Yes |
| `GITHUB_APP_ID` | Repo access | Yes |
| `GITHUB_APP_PRIVATE_KEY` | Repo access | Yes |
| `GITHUB_APP_SLUG` | GitHub App slug for install URL | Yes |

### User Credentials (NOT Platform Secrets)

**Hetzner API tokens are provided by users through the Settings UI**, stored encrypted per-user in the database. They are NOT environment variables or Worker secrets.

See `docs/architecture/credential-security.md` for details.

### Development Environment

See `apps/api/.env.example`:
- `WRANGLER_PORT` - Local dev port (default: 8787)
- `BASE_DOMAIN` - Set automatically by sync scripts

## Active Technologies
- TypeScript 5.x + Hono (API), React + Vite (UI), Cloudflare Workers (001-mvp)
- Cloudflare KV (MVP), D1 (future multi-tenancy) (001-mvp)
- TypeScript 5.x + @devcontainers/cli (exec'd via child process), Hono (API), React + Vite (UI) (002-local-mock-mode)
- In-memory (Map) for mock mode; no persistent storage (002-local-mock-mode)
- TypeScript 5.x + BetterAuth + Drizzle ORM + jose (API), React + Vite + TailwindCSS + xterm.js (Web) (003-browser-terminal-saas)
- Go 1.22+ + creack/pty + gorilla/websocket + golang-jwt (VM Agent) (003-browser-terminal-saas)
- Cloudflare D1 (SQLite) + KV (sessions) + R2 (binaries) (003-browser-terminal-saas)
- TypeScript 5.x (API, Web, packages) + Go 1.22+ (VM Agent) + Hono (API), React + Vite (Web), xterm.js (Terminal), Drizzle ORM (Database) (004-mvp-hardening)
- Cloudflare D1 (workspaces), Cloudflare KV (sessions, bootstrap tokens) (004-mvp-hardening)
- TypeScript 5.x (Node.js 20+) + Wrangler 3.100+, Hono (API), React + Vite (Web), pnpm 9.0+ (005-automated-deployment)
- Cloudflare D1 (SQLite), KV (sessions/tokens), R2 (binaries) (005-automated-deployment)
- TypeScript 5.x (Node.js 20+) + `@pulumi/pulumi`, `@pulumi/cloudflare`, `wrangler`, `@iarna/toml` (005-automated-deployment)
- Cloudflare R2 (Pulumi state), D1 (app data), KV (sessions) (005-automated-deployment)

## Recent Changes
- 004-mvp-hardening: Secure bootstrap tokens, workspace ownership validation, provisioning timeouts, shared terminal package, WebSocket reconnection, idle deadline tracking
- 003-browser-terminal-saas: Added multi-tenant SaaS with GitHub OAuth, VM Agent (Go), browser terminal
- 002-local-mock-mode: Added local mock mode with devcontainers CLI
- 001-mvp: Added TypeScript 5.x + Hono (API), React + Vite (UI), Cloudflare Workers
