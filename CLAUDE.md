# Simple Agent Manager (SAM)

A serverless platform to spin up AI coding agent environments on-demand with zero ongoing cost.

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

1. **Make changes locally** — Use your IDE, run lint/typecheck
2. **Deploy to staging** — Via GitHub Actions or `pnpm deploy:setup --environment staging`
3. **Test on Cloudflare** — Real D1, real KV, real Workers
4. **Merge to main** — Triggers production deployment

### Local Dev Limitations (NOT Recommended for Testing)

Running `pnpm dev` starts local emulators but has significant limitations:
- No real GitHub OAuth (callbacks won't work)
- No real DNS (workspace URLs won't resolve)
- No real VMs (workspaces can't be created)
- D1/KV emulation may differ from production

**For any meaningful testing, deploy to staging.** See `docs/guides/local-development.md`.

### Playwright Artifacts (Development)

Store all Playwright screenshots from development and verification runs in `.codex/tmp/playwright-screenshots/` (gitignored). Do not save screenshots in tracked directories.

## Common Commands

```bash
pnpm install          # Install dependencies
pnpm dev              # Run development servers (LIMITED - see above)
pnpm test             # Run tests
pnpm build            # Build all packages
pnpm typecheck        # Type check
pnpm lint             # Lint
pnpm format           # Format
```

## Deployment

**Continuous Deployment:** Merge to `main` automatically deploys to production.

### Configuration (GitHub Environment)

All configuration lives in **GitHub Settings -> Environments -> production**:

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

- **CI** (`ci.yml`): Runs on all pushes/PRs — lint, typecheck, test, build
- **Deploy** (`deploy.yml`): Runs on push to main — full Pulumi + Wrangler deployment
- **Teardown** (`teardown.yml`): Manual only — destroys all resources (type "DELETE" to confirm)

## Key Concepts

- **Workspace**: An AI coding environment (VM + devcontainer + Claude Code)
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **CloudCLI**: Web-based Claude Code interface (file explorer + terminal)
- **Idle Detection**: VMs self-terminate after inactivity (default 30 minutes, configurable via `IDLE_TIMEOUT_SECONDS`)
- **OAuth Authentication**: Claude Code supports both API keys and OAuth tokens from Claude Max/Pro subscriptions

## API Endpoints

### Workspace Management
- `POST /api/workspaces` — Create workspace
- `GET /api/workspaces` — List user's workspaces
- `GET /api/workspaces/:id` — Get workspace details
- `POST /api/workspaces/:id/stop` — Stop a running workspace
- `POST /api/workspaces/:id/restart` — Restart a workspace
- `DELETE /api/workspaces/:id` — Delete a workspace
- `GET /api/workspaces/:id/ready` — Check workspace readiness

### VM Communication
- `POST /api/workspaces/:id/heartbeat` — VM heartbeat with idle detection
- `POST /api/workspaces/:id/boot-log` — VM sends boot progress log entry (callback JWT auth)
- `POST /api/bootstrap/:token` — Redeem one-time bootstrap token (credentials + git identity)
- `POST /api/agent/ready` — VM agent ready callback
- `POST /api/agent/activity` — VM agent activity report

### Terminal Access
- `POST /api/terminal/token` — Get terminal WebSocket token

### Authentication (BetterAuth)
- `POST /api/auth/sign-in/social` — GitHub OAuth login
- `GET /api/auth/session` — Get current session
- `POST /api/auth/sign-out` — Sign out

### Credentials
- `GET /api/credentials` — Get user's cloud provider credentials
- `PUT /api/credentials` — Save cloud provider credentials

### GitHub Integration
- `GET /api/github/installations` — List user's GitHub App installations
- `GET /api/github/repos` — List accessible repositories

## Platform Secrets (Cloudflare Worker)

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

## Agent Authentication

### Claude Code OAuth Support

Claude Code now supports dual authentication methods:

1. **API Keys**: Traditional pay-per-use API keys from Anthropic Console
2. **OAuth Tokens**: Tokens from Claude Max/Pro subscriptions via `claude setup-token`

#### Using OAuth Tokens

1. Generate a token on your local machine: `claude setup-token`
2. In SAM Settings, select "OAuth Token (Pro/Max)" for Claude Code
3. Paste the token and save
4. The system automatically injects `CLAUDE_CODE_OAUTH_TOKEN` instead of `ANTHROPIC_API_KEY`

#### Credential Switching

- Users can store both an API key and OAuth token
- Toggle between them in Settings
- New credentials auto-activate by default
- Delete specific credential types via the API

## Active Technologies
- Markdown (CommonMark) with GitHub Flavored Markdown extensions + None (documentation-only review) (010-docs-review)
- Git (version-controlled markdown files) (010-docs-review)
- TypeScript 5.x (React frontend), Go 1.22 (VM Agent) + React 18, xterm.js 5.3, Hono 3.x, gorilla/websocket, creack/pty (011-multi-terminal-ui)
- In-memory session state only (no persistent storage per constitution) (011-multi-terminal-ui)
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
- TypeScript 5.x + React 18 + Vite 5 + shadcn-compatible open-code component workflow, Radix UI primitives, Tailwind-style design tokens/utilities, existing `lucide-react` icons (009-ui-system-standards)
- Git-tracked specification artifacts and shared package source files (no new runtime database storage) (009-ui-system-standards)
- Go 1.22+ (VM Agent), TypeScript 5.x (Browser terminal package) + `github.com/creack/pty`, `github.com/gorilla/websocket` (Go); React 18, xterm.js 5.3 (Browser) (012-pty-session-persistence)
- In-memory only (Go maps, ring buffers) — no database or persistent storage (012-pty-session-persistence)
- TypeScript 5.x (API, Web), Go 1.22 (VM Agent) + Hono (API), React 18 (Web UI), Drizzle ORM (database), creack/pty + gorilla/websocket (VM Agent) (013-agent-oauth-support)
- Cloudflare D1 (credentials table with new schema), AES-256-GCM encryption (013-agent-oauth-support)

## Recent Changes
- 014-auth-profile-sync: Resolve and persist the GitHub account primary email at login (via `/user/emails`) and propagate git user name/email into workspace bootstrap so VM agent configures commit identity
- 013-agent-oauth-support: Dual credential support for Claude Code (API key + OAuth token), credential switching capability, auto-activation behavior
- 012-pty-session-persistence: PTY sessions survive page refresh/network interruptions with ring buffer replay and session reattach; orphan cleanup is configurable and disabled by default (`PTY_ORPHAN_GRACE_PERIOD=0`)
- 010-docs-review: Added Markdown (CommonMark) with GitHub Flavored Markdown extensions + None (documentation-only review)
- 004-mvp-hardening: Secure bootstrap tokens, workspace ownership validation, provisioning timeouts, shared terminal package, WebSocket reconnection, idle deadline tracking
- 003-browser-terminal-saas: Added multi-tenant SaaS with GitHub OAuth, VM Agent (Go), browser terminal
