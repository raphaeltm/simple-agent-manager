# Getting Started with Simple Agent Manager

This guide walks you through setting up Simple Agent Manager (SAM) for local development.

> **Want to deploy instead?** See the [Self-Hosting Guide](./self-hosting.md) for production deployment instructions.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+ (fast package manager for monorepos)
- [Go](https://go.dev/) 1.22+ (only needed if working on the VM Agent)
- A [Cloudflare account](https://cloudflare.com/) (free tier works)
- A domain managed by Cloudflare DNS
- A [GitHub OAuth App](https://github.com/settings/developers) and [GitHub App](https://github.com/settings/apps) (see [Self-Hosting Guide](./self-hosting.md#github-setup) for setup instructions)

## Quick Start

### 1. Clone the Repository

```bash
git clone https://github.com/your-org/simple-agent-manager.git
cd simple-agent-manager
```

### 2. Install Dependencies

```bash
pnpm install
```

### 3. Set Up Environment Variables

Copy the example environment file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Cloudflare configuration
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id
CF_ACCOUNT_ID=your-account-id
BASE_DOMAIN=example.com

# GitHub OAuth App (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret

# GitHub App (create at https://github.com/settings/apps)
GITHUB_APP_ID=your-github-app-id
GITHUB_APP_PRIVATE_KEY=your-github-app-private-key-base64
GITHUB_APP_SLUG=your-github-app-slug

# Security keys (generate with: pnpm tsx scripts/deploy/generate-keys.ts)
ENCRYPTION_KEY=your-encryption-key-base64
JWT_PRIVATE_KEY=your-jwt-private-key-base64
JWT_PUBLIC_KEY=your-jwt-public-key-base64
```

> **Note**: Local `.env` files use `GITHUB_*` prefix. For GitHub Actions deployment, use `GH_*` prefix in GitHub Environment secrets. The deployment workflow maps between them. See [CLAUDE.md](../../CLAUDE.md) and [AGENTS.md](../../AGENTS.md) for details.

> **Note**: Hetzner API tokens are NOT platform configuration. Users provide their own tokens through the Settings UI after logging in. See [credential-security.md](../architecture/credential-security.md) for details.

### 4. Build and Test

```bash
# Build all packages
pnpm build

# Run tests
pnpm test

# Type checking
pnpm typecheck
```

### 5. Start Development Servers

```bash
pnpm dev
```

This starts:
- API server at `http://localhost:8787`
- Web UI at `http://localhost:5173`

> **Important**: Local development has significant limitations. Real GitHub OAuth, DNS, and VM provisioning require a deployed environment. For meaningful testing, deploy to staging. See [local-development.md](./local-development.md) for details.

## Project Structure

```
simple-agent-manager/
├── apps/
│   ├── api/              # Cloudflare Worker API (Hono)
│   └── web/              # Control Plane UI (React + Vite)
├── packages/
│   ├── shared/           # Shared types and utilities
│   ├── providers/        # Cloud provider abstraction (Hetzner)
│   ├── cloud-init/       # VM cloud-init template generation
│   ├── terminal/         # Shared terminal component (xterm.js + WebSocket)
│   ├── ui/               # Shared UI component library
│   ├── vm-agent/         # Go agent for WebSocket terminal + ACP
│   └── acp-client/       # Agent Communication Protocol client
├── infra/                # Pulumi infrastructure as code
├── scripts/
│   ├── vm/               # VM-side config templates
│   └── deploy/           # Deployment utilities
├── specs/                # Feature specifications
└── docs/                 # Documentation
```

## Creating Your First Workspace

1. Open the web UI at `https://app.example.com` (deployed environment)
2. Sign in with GitHub (BetterAuth OAuth)
3. Add your Hetzner API token in **Settings**
4. Install the GitHub App on a repository
5. Click **New Workspace** and select:
   - Repository (from your installed GitHub Apps)
   - VM Size: Medium (recommended for most use cases)
6. Click **Create Workspace**

The workspace provisions in 2-5 minutes. Once running:
1. Click the workspace to open the browser-based terminal (xterm.js via VM Agent)
2. Run `claude login` to authenticate with your Claude Max subscription
3. Start using Claude Code!

## API Overview

SAM uses session-based authentication via BetterAuth with GitHub OAuth. Key endpoints:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/workspaces` | `POST` | Create a new workspace |
| `/api/workspaces` | `GET` | List your workspaces |
| `/api/workspaces/:id` | `GET` | Get workspace details |
| `/api/workspaces/:id/stop` | `POST` | Stop a running workspace |
| `/api/workspaces/:id/restart` | `POST` | Restart a workspace |
| `/api/workspaces/:id` | `DELETE` | Delete a workspace |

See the [README API Reference](../../README.md#api-reference) for the complete endpoint list.

## Deploying to Production

SAM uses **continuous deployment** — merging to `main` automatically deploys to production via GitHub Actions.

For first-time setup:
1. Configure a GitHub Environment named `production` with required secrets
2. Push to `main` or manually trigger the Deploy workflow

See the [Self-Hosting Guide](./self-hosting.md) for detailed deployment instructions.

## Troubleshooting

### Build Errors

Build packages in dependency order:

```bash
pnpm --filter @simple-agent-manager/shared build
pnpm --filter @simple-agent-manager/providers build
pnpm --filter @simple-agent-manager/api build
```

Or use `pnpm build` from the root to build everything via Turborepo.

### DNS Issues

Check your Cloudflare zone ID and API token permissions. The token needs DNS edit permissions.

### VM Not Starting

Check the Hetzner Cloud console for server status. Common issues:
- Invalid or missing Hetzner API token (check Settings)
- Region capacity limits
- Account spending limits

See [deployment-troubleshooting.md](./deployment-troubleshooting.md) for more diagnostic steps.

## Next Steps

- Read the [Architecture Decision Records](../adr/) for design rationale
- Review [CONTRIBUTING.md](../../CONTRIBUTING.md) for contribution guidelines
- Explore the [Self-Hosting Guide](./self-hosting.md) for production deployment
- Check [local-development.md](./local-development.md) for local dev limitations and tips
