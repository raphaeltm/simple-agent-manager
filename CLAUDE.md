# Cloud AI Coding Workspaces

A serverless platform to spin up AI coding agent environments on-demand with zero ongoing cost.

## Project Overview

This is a monorepo containing a Cloudflare-based platform for managing ephemeral Claude Code workspaces. Users can create cloud VMs with Claude Code pre-installed from any git repository, access them via a web-based interface (CloudCLI), and have them automatically terminate when idle.

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
└── providers/    # Cloud provider abstraction (Hetzner)

scripts/
└── vm/           # VM-side scripts (cloud-init, idle detection)

specs/            # Feature specifications
docs/             # Documentation
```

## Common Commands

```bash
# Install dependencies
pnpm install

# Run development servers
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

## Key Concepts

- **Workspace**: An AI coding environment (VM + devcontainer + Claude Code)
- **Provider**: Cloud infrastructure abstraction (currently Hetzner only)
- **CloudCLI**: Web-based Claude Code interface (file explorer + terminal)
- **Idle Detection**: VMs self-terminate after 30 minutes of inactivity

## API Endpoints

- `POST /vms` - Create workspace
- `GET /vms` - List workspaces
- `GET /vms/:id` - Get workspace details
- `DELETE /vms/:id` - Stop workspace
- `POST /vms/:id/cleanup` - Cleanup callback (called by VM)

## Environment Variables

See `.env.example` for required configuration:
- `CF_API_TOKEN` - Cloudflare API token
- `CF_ZONE_ID` - Cloudflare DNS zone
- `HETZNER_TOKEN` - Hetzner Cloud API token
- `API_TOKEN` - Bearer token for API authentication
- `BASE_DOMAIN` - Domain for workspace URLs

## Active Technologies
- TypeScript 5.x + Hono (API), React + Vite (UI), Cloudflare Workers (001-mvp)
- Cloudflare KV (MVP), D1 (future multi-tenancy) (001-mvp)
- TypeScript 5.x + @devcontainers/cli (exec'd via child process), Hono (API), React + Vite (UI) (002-local-mock-mode)
- In-memory (Map) for mock mode; no persistent storage (002-local-mock-mode)
- TypeScript 5.x + BetterAuth + Drizzle ORM + jose (API), React + Vite + TailwindCSS + xterm.js (Web) (003-browser-terminal-saas)
- Go 1.22+ + creack/pty + gorilla/websocket + golang-jwt (VM Agent) (003-browser-terminal-saas)
- Cloudflare D1 (SQLite) + KV (sessions) + R2 (binaries) (003-browser-terminal-saas)

## Recent Changes
- 003-browser-terminal-saas: Added multi-tenant SaaS with GitHub OAuth, VM Agent (Go), browser terminal
- 002-local-mock-mode: Added local mock mode with devcontainers CLI
- 001-mvp: Added TypeScript 5.x + Hono (API), React + Vite (UI), Cloudflare Workers
