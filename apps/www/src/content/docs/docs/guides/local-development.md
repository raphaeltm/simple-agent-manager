---
title: Local Development
description: Set up SAM for local development with Wrangler's local emulator.
---

SAM uses a **Cloudflare-first development approach**. Local development has significant limitations — no real OAuth, DNS, or VMs. For meaningful testing, deploy to staging.

## Recommended Workflow

1. **Make changes locally** — edit code, run lint and typecheck
2. **Deploy to staging** — via GitHub Actions or `pnpm deploy:setup --environment staging`
3. **Test on Cloudflare** — real D1, KV, Workers, DNS
4. **Merge to main** — triggers production deployment

## What Works Locally

For quick iteration on API logic, you can use Wrangler's local emulator:

```bash
pnpm dev
```

This starts:
- **API** at `http://localhost:8787` (Wrangler with Miniflare)
- **Web UI** at `http://localhost:5173` (Vite dev server)

### Limitations

| Feature | Local | Staging |
|---------|-------|---------|
| GitHub OAuth | No (callbacks won't work) | Yes |
| DNS/subdomains | No | Yes |
| VM provisioning | No | Yes |
| D1/KV/R2 | Emulated (may differ) | Real |
| Agent sessions | No | Yes |

## Prerequisites

```bash
node --version   # v20.x or higher
pnpm --version   # 9.x or higher
```

Go 1.22+ is only needed if you're working on the VM Agent (`packages/vm-agent/`).

## Setup

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Generate Development Keys

```bash
pnpm tsx scripts/deploy/generate-keys.ts
```

This generates `ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, and `JWT_PUBLIC_KEY` for local use.

### 3. Create `.dev.vars`

Create `apps/api/.dev.vars` with minimal configuration:

```bash
BASE_DOMAIN=localhost:8787
ENCRYPTION_KEY=<from generate-keys>
JWT_PRIVATE_KEY=<from generate-keys>
JWT_PUBLIC_KEY=<from generate-keys>
```

### 4. Run

```bash
pnpm dev
```

## Build & Test

```bash
pnpm build       # Build all packages
pnpm test        # Run tests
pnpm typecheck   # Type check
pnpm lint        # Lint
pnpm format      # Format
```

### Build Order

Packages must be built in dependency order:

```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

Or use `pnpm build` from the root — Turborepo handles ordering.

## Project Structure

```
apps/
├── api/          # Cloudflare Worker API (Hono)
├── web/          # Control plane UI (React + Vite)
├── www/          # Marketing site + docs (Astro)
└── tail-worker/  # Log aggregation worker

packages/
├── shared/       # Shared types and utilities
├── providers/    # Cloud provider abstraction (Hetzner)
├── cloud-init/   # Cloud-init template generator
├── terminal/     # Shared terminal component (xterm.js)
├── ui/           # Design system components
└── vm-agent/     # Go VM agent (PTY, WebSocket, ACP)
```

## Staging Deployment

For real testing, deploy to a staging environment:

```bash
# Via GitHub Actions (recommended)
# Trigger the "Deploy Setup" workflow with environment=staging

# Or via CLI
pnpm deploy:setup --environment staging
```

Staging gives you the full Cloudflare stack: real D1, KV, Workers, DNS, and VM provisioning.
