# Local Development Guide

**Last Updated**: 2025-01-26

## Overview

This guide explains how to run the Cloud AI Workspaces control plane locally for development.

---

## Prerequisites

1. **Node.js 20+** and **pnpm 9+**
   ```bash
   node --version  # v20.x.x
   pnpm --version  # 9.x.x
   ```

2. **Wrangler CLI** (installed as dev dependency)
   ```bash
   pnpm install
   ```

3. **Environment variables** configured (see below)

---

## Setup

### 1. Clone and Install

```bash
git clone https://github.com/your-org/cloud-ai-workspaces.git
cd cloud-ai-workspaces
pnpm install
```

### 2. Generate Keys

```bash
pnpm generate-keys
```

This generates JWT and encryption keys and outputs them for your `.dev.vars` file.

### 3. Configure Environment

Create `apps/api/.dev.vars` with your development credentials:

```bash
# Cloudflare (for DNS)
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id

# Domain
BASE_DOMAIN=localhost

# GitHub OAuth (create a dev app at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your-dev-github-client-id
GITHUB_CLIENT_SECRET=your-dev-github-client-secret

# GitHub App (create at https://github.com/settings/apps)
GITHUB_APP_ID=your-github-app-id
GITHUB_APP_PRIVATE_KEY=base64-encoded-private-key

# JWT Keys (from pnpm generate-keys)
JWT_PRIVATE_KEY=base64-encoded-private-key
JWT_PUBLIC_KEY=base64-encoded-public-key

# Encryption Key (from pnpm generate-keys)
ENCRYPTION_KEY=base64-encoded-key
```

### 4. Initialize Local Database

```bash
pnpm db:migrate:local
```

---

## Running Locally

```bash
pnpm dev
```

This starts:
- **API** at `http://localhost:8787` (Wrangler dev server)
- **Web UI** at `http://localhost:5173` (Vite dev server)

---

## Architecture Notes

The local development setup uses:
- **Wrangler** to emulate Cloudflare Workers locally
- **Local D1** SQLite database (`.wrangler/state/`)
- **Real GitHub OAuth** (you need a dev OAuth app)
- **Real Hetzner** if creating workspaces (user provides their token)

---

## Testing

```bash
# Run all tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Type checking
pnpm typecheck
```

---

## Troubleshooting

### "OAuth callback failed"

Ensure your GitHub OAuth app has the correct callback URL:
- Development: `http://localhost:5173/api/auth/callback/github`

### "D1 database not found"

Run the local migration:
```bash
pnpm db:migrate:local
```

### "JWT verification failed"

Regenerate your keys:
```bash
pnpm generate-keys
```

And update your `.dev.vars` file.

---

## Deprecated: Mock Mode

> **Note**: The previous mock mode (`pnpm dev:mock`) that used local devcontainers is no longer functional. The API has been rewritten to use D1/KV/R2 storage and BetterAuth, which requires the Wrangler development environment.

For local testing without cloud resources, use the standard `pnpm dev` with a local D1 database. Workspace creation will still require a Hetzner account.
