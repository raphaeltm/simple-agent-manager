# Local Development Guide

**Last Updated**: 2026-01-30

---

## ⚠️ Important: Cloudflare-First Development

**This project uses a Cloudflare-first development approach.** Per the [project constitution](./../.specify/memory/constitution.md#development-workflow):

> "No complex local testing setups. Iterate directly on Cloudflare infrastructure."

**Why?** This project has many moving pieces (Workers, D1, KV, DNS, VMs, VM Agent). Setting up a realistic local environment is impractical. Instead, we deploy frequently to staging and test there.

### Recommended Workflow

1. **Make changes locally** - Use your IDE, run lint/typecheck
2. **Deploy to staging** - `pnpm deploy:staging`
3. **Test on Cloudflare** - Real D1, real KV, real Workers
4. **Merge to main** - Triggers production deployment

---

## What Still Works Locally

For **quick iteration on API logic**, you can use Wrangler's local emulator:

```bash
pnpm dev
```

This starts:
- **API** at `http://localhost:8787` (Wrangler dev server with miniflare)
- **Web UI** at `http://localhost:5173` (Vite dev server)

### Limitations of Local Dev

- **No real GitHub OAuth** - Callbacks won't work without tunnel setup
- **No real DNS** - Workspace URLs won't resolve
- **No real VMs** - Workspaces can't be created
- **D1/KV/R2 emulation** - May differ from production behavior

**For any meaningful testing, deploy to staging.**

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

---

## Basic Local Setup (Limited Use)

### 1. Install Dependencies

```bash
pnpm install
```

### 2. Generate Development Keys

```bash
pnpm tsx scripts/deploy/generate-keys.ts
```

### 3. Create `.dev.vars` (Optional)

Create `apps/api/.dev.vars` with minimal configuration:

```bash
# Minimal local dev config
BASE_DOMAIN=localhost:8787
ENCRYPTION_KEY=<from generate-keys>
JWT_PRIVATE_KEY=<from generate-keys>
JWT_PUBLIC_KEY=<from generate-keys>
```

### 4. Run Local Server

```bash
pnpm dev
```

---

## Testing

Tests run locally without Cloudflare:

```bash
# Run all tests
pnpm test

# Run tests with coverage
pnpm test:coverage

# Type checking
pnpm typecheck

# Lint
pnpm lint
```

---

## Staging Deployment (Recommended for Testing)

### Prerequisites

1. Cloudflare account with Workers, D1, KV, R2 enabled
2. GitHub secrets configured (see [self-hosting guide](./self-hosting.md))

### Deploy to Staging

```bash
# Via GitHub Actions (recommended)
# Trigger the "Deploy Setup" workflow with environment=staging

# Or via CLI (if configured)
pnpm deploy:staging
```

### Teardown Staging

```bash
# Via GitHub Actions
# Trigger the "Teardown Setup" workflow with environment=staging
```

---

## Deprecated Features

### Mock Mode (Removed)

The previous mock mode (`pnpm dev:mock`) that used local devcontainers has been **removed**. It was:
- Overly complex to maintain
- Didn't accurately represent production behavior
- Required Docker and devcontainers CLI

The Cloudflare-first approach replaces this entirely.

### setup-local-dev.ts (Deprecated)

The `pnpm setup:local` script exists for historical reasons but is **not recommended**. Use staging deployment instead.

---

## Troubleshooting

### "Can't test OAuth locally"

Deploy to staging with proper GitHub OAuth app configured. Local OAuth requires tunnel setup which is complex and error-prone.

### "Workspace creation fails locally"

Workspace creation requires real Hetzner VMs and DNS. This cannot work in local emulation. Deploy to staging.

### "D1/KV behavior differs"

Local emulation (miniflare) may differ from production. Always verify important changes in staging.
