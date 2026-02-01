# Quickstart Guide: Simple Agent Manager

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Phase**: 1 - Design
**Date**: 2026-01-24

## Prerequisites

Before setting up the development environment, ensure you have:

### Required Accounts
- **Cloudflare Account** - For Pages, Workers, and DNS management
- **Hetzner Cloud Account** - For VM provisioning ([Create account](https://accounts.hetzner.com/signUp))
- **Claude Max Subscription** - For Claude Code functionality (authenticate via `claude login` in workspace)

### Required Tools
- **Node.js 20+** - JavaScript runtime
- **pnpm 8+** - Package manager (`npm install -g pnpm`)
- **Git** - Version control
- **Wrangler CLI** - Cloudflare tooling (`npm install -g wrangler`)

### Optional Tools
- **Turbo** - Monorepo build tool (`npm install -g turbo`)

---

## Quick Setup

### 1. Clone and Install

```bash
# Clone repository
git clone https://github.com/your-org/simple-agent-manager.git
cd simple-agent-manager

# Install dependencies
pnpm install
```

### 2. Configure Environment

```bash
# Copy environment template
cp .env.example .env

# Edit with your values
nano .env
```

**Required Environment Variables**:

```bash
# .env (root - for local development reference)

# Cloudflare
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id
CF_ACCOUNT_ID=your-account-id

# Hetzner
HETZNER_TOKEN=your-hetzner-api-token

# API Authentication (generate a secure token)
API_TOKEN=your-secure-api-token

# Domain
BASE_DOMAIN=example.com
```

### 3. Configure Cloudflare Workers

```bash
# Login to Cloudflare
wrangler login

# Create secrets for the API worker
cd apps/api
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ZONE_ID
wrangler secret put HETZNER_TOKEN
wrangler secret put API_TOKEN
wrangler secret put BASE_DOMAIN
```

### 4. Start Development Servers

```bash
# From repository root
pnpm dev

# Or start individual apps:
pnpm --filter @simple-agent-manager/api dev    # API on localhost:8787
pnpm --filter @simple-agent-manager/web dev    # UI on localhost:5173
```

---

## Development Workflow

### Running Tests

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Run specific package tests
pnpm --filter @simple-agent-manager/api test
pnpm --filter @simple-agent-manager/providers test
```

### Building for Production

```bash
# Build all packages
pnpm build

# Build specific package
pnpm --filter @simple-agent-manager/api build
```

### Linting and Formatting

```bash
# Lint all packages
pnpm lint

# Fix linting issues
pnpm lint:fix

# Format code
pnpm format
```

### Type Checking

```bash
# Check all packages
pnpm typecheck
```

---

## Deployment

### Deploy to Staging

```bash
# Deploy API to staging
pnpm --filter @simple-agent-manager/api deploy:staging

# Deploy UI to staging
pnpm --filter @simple-agent-manager/web deploy:staging
```

### Deploy to Production

```bash
# Deploy API to production
pnpm --filter @simple-agent-manager/api deploy

# Deploy UI to production
pnpm --filter @simple-agent-manager/web deploy
```

---

## Project Structure

```
simple-agent-manager/
├── apps/
│   ├── api/                 # Cloudflare Worker API
│   │   ├── src/
│   │   │   ├── routes/      # API route handlers
│   │   │   ├── services/    # Business logic
│   │   │   └── lib/         # Utilities
│   │   ├── tests/
│   │   └── wrangler.toml
│   │
│   └── web/                 # Cloudflare Pages UI
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   └── services/
│       └── tests/
│
├── packages/
│   ├── providers/           # Cloud provider abstraction
│   │   └── src/
│   │       ├── types.ts
│   │       └── hetzner.ts
│   │
│   └── shared/              # Shared types and utilities
│       └── src/
│           └── types.ts
│
├── scripts/
│   └── vm/                  # VM-side scripts
│       ├── cloud-init.yaml
│       └── idle-check.sh
│
└── docs/                    # Documentation
    ├── guides/
    └── adr/
```

---

## API Usage

### Create a Workspace

```bash
# Note: No Anthropic API key required - authenticate via 'claude login' after workspace is ready
curl -X POST https://api.example.com/vms \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "repoUrl": "https://github.com/user/my-project",
    "size": "medium"
  }'
```

### Authenticate Claude Code

After workspace creation:

1. **Access your workspace**: Navigate to the workspace URL (e.g., `https://ui.ws-abc123.vm.example.com`)
2. **Open CloudCLI terminal**: The web-based terminal interface
3. **Run authentication**: Execute `claude login` in the terminal
4. **Complete browser auth**: Follow prompts to authenticate with your Claude Max account
5. **Ready to use**: Claude Code is now authenticated and ready!

### List Workspaces

```bash
curl https://api.example.com/vms \
  -H "Authorization: Bearer $API_TOKEN"
```

### Stop a Workspace

```bash
curl -X DELETE https://api.example.com/vms/ws-abc123 \
  -H "Authorization: Bearer $API_TOKEN"
```

---

## Common Tasks

### Adding a New Provider

1. Create provider file in `packages/providers/src/`:
   ```typescript
   // packages/providers/src/scaleway.ts
   import { Provider, VMConfig, VMInstance } from './types';

   export class ScalewayProvider implements Provider {
     // Implement interface methods
   }
   ```

2. Export from package index:
   ```typescript
   // packages/providers/src/index.ts
   export { ScalewayProvider } from './scaleway';
   ```

3. Add tests in `packages/providers/tests/`:
   ```typescript
   // packages/providers/tests/scaleway.test.ts
   ```

### Adding a New API Endpoint

1. Create route handler in `apps/api/src/routes/`:
   ```typescript
   // apps/api/src/routes/new-endpoint.ts
   import { Hono } from 'hono';

   export const newEndpoint = new Hono();

   newEndpoint.get('/', async (c) => {
     return c.json({ message: 'Hello' });
   });
   ```

2. Register in main app:
   ```typescript
   // apps/api/src/index.ts
   import { newEndpoint } from './routes/new-endpoint';
   app.route('/new', newEndpoint);
   ```

3. Add tests in `apps/api/tests/routes/`.

---

## Troubleshooting

### "Wrangler not found"

```bash
npm install -g wrangler
wrangler login
```

### "Provider API rate limited"

Hetzner has rate limits. Wait and retry, or use the staging environment.

### "DNS not resolving"

DNS propagation can take 1-2 minutes. Check Cloudflare dashboard for record creation.

### "Tests failing locally"

Ensure environment variables are set:
```bash
source .env
pnpm test
```

---

## Next Steps

1. Review the [spec.md](./spec.md) for feature requirements
2. Check [data-model.md](./data-model.md) for entity definitions
3. See [contracts/api.md](./contracts/api.md) for API specification
4. Read the [research.md](./research.md) for technical decisions

For questions, open an issue in the repository.
