<p align="center">
  <img src="assets/images/logo.png" alt="Simple Agent Manager" width="400" />
</p>

<p align="center">
  <strong>Simple Agent Manager (SAM) - Spin up AI coding environments on-demand.</strong>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> •
  <a href="#features">Features</a> •
  <a href="docs/">Documentation</a> •
  <a href="ROADMAP.md">Roadmap</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square" alt="License" /></a>
</p>

---

Simple Agent Manager (SAM) is a serverless platform for creating ephemeral cloud development environments optimized for [Claude Code](https://www.anthropic.com/claude-code). Point it at any GitHub repository and get a fully configured workspace with Claude Code pre-installed—accessible from your browser in minutes.

Think **GitHub Codespaces, but built for AI-assisted development** with explicit lifecycle controls and node-level consolidation.

## **WARNING** this thing is fully vibe coded, with some code review, but not a lot yet. It has not yet beeen tested, so you should not use it at the moment.

## Why Simple Agent Manager?

|                   | GitHub Codespaces       | Simple Agent Manager                 |
| ----------------- | ----------------------- | ------------------------------------ |
| **Cost**          | $0.18–$0.36/hour        | ~$0.07–$0.15/hour                    |
| **Lifecycle control** | Manual or 30min timeout | Explicit workspace/node stop, restart, and delete |
| **Claude Code**   | Manual setup required   | Pre-installed and optimized          |
| **Private repos** | Native GitHub support   | GitHub App integration               |
| **Control plane** | Managed                 | Self-hosted (free tier)              |

### Key Differentiators

- **2-3x cheaper** than hosted alternatives using Hetzner Cloud VMs
- **Node consolidation** — run multiple workspaces on a single node VM
- **Operator-controlled lifecycle** — explicit stop/restart/delete actions for nodes and workspaces
- **Claude Code first** — pre-installed, session persistence, MCP server support
- **Private repository support** — secure GitHub App integration for your org

## Features

- **Instant Workspaces** — Create a cloud VM from any Git repository in minutes
- **Multi-Terminal Support** — Open multiple terminal sessions in tabs without new browser windows
- **Session Reattach & Recovery** — On reconnect, tabs hydrate from VM session state; orphaned sessions persist until explicitly closed by default
- **Web Terminal** — Access via browser-based xterm.js terminal with WebSocket connection
- **Installable PWA** — Add SAM to your home screen for app-like mobile access
- **DevContainer Support** — Automatically detects and uses your `.devcontainer/devcontainer.json`
- **Multiple VM Sizes** — Small (2 vCPU/4GB), Medium (4 vCPU/8GB), Large (8 vCPU/16GB)
- **Explicit Lifecycle Controls** — Stop, restart, and delete workspaces/nodes on demand
- **GitHub Integration** — Works with both public and private repositories
- **Keyboard-Safe Mobile Layout** — Viewport-aware sizing keeps core controls visible as browser UI and mobile keyboard appear/disappear

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 9+
- [Cloudflare account](https://cloudflare.com/) (free tier works)
- [Hetzner Cloud account](https://hetzner.cloud/)
- A domain managed by Cloudflare

### Installation

```bash
# Clone the repository
git clone https://github.com/your-org/simple-agent-manager.git
cd simple-agent-manager

# Install dependencies
pnpm install

# Copy environment template
cp .env.example .env
# Edit .env with your API tokens and domain
```

### Configuration (Local Development)

Create your `.env` file with the following.

> **Note**: These `GITHUB_*` names are for **local `.env` files only**. For GitHub Actions deployment, use `GH_*` prefix in GitHub Environment secrets (e.g., `GH_CLIENT_ID` instead of `GITHUB_CLIENT_ID`). The deployment workflow maps between them automatically.

```bash
# Cloudflare (for DNS and hosting)
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id
CF_ACCOUNT_ID=your-account-id

# Domain for workspace URLs (e.g., workspaces.example.com)
BASE_DOMAIN=example.com

# GitHub OAuth (create at https://github.com/settings/developers)
GITHUB_CLIENT_ID=your-github-oauth-client-id
GITHUB_CLIENT_SECRET=your-github-oauth-client-secret

# GitHub App (create at https://github.com/settings/apps)
GITHUB_APP_ID=your-github-app-id
GITHUB_APP_PRIVATE_KEY=your-github-app-private-key-base64
GITHUB_APP_SLUG=your-github-app-slug

# JWT Keys (generate with: tsx scripts/deploy/generate-keys.ts)
JWT_PRIVATE_KEY=your-jwt-private-key-base64
JWT_PUBLIC_KEY=your-jwt-public-key-base64

# Encryption key for credential storage (32 bytes, base64)
ENCRYPTION_KEY=your-encryption-key-base64
```

> **Note:** Run `tsx scripts/deploy/generate-keys.ts` to generate JWT and encryption keys.
> User Hetzner tokens are stored encrypted per-user, not as environment variables.

### Development

```bash
# Start development servers (API + Web UI)
pnpm dev

# Run tests
pnpm test

# Type checking
pnpm typecheck

# Build for production
pnpm build
```

### Deployment

**Continuous Deployment:** Merge to `main` automatically deploys to production.

Before your first deployment, configure the GitHub Environment:

1. Go to **Settings → Environments → New environment**
2. Create environment named `production`
3. Add required variables and secrets (see [CLAUDE.md](CLAUDE.md#deployment) for full list):
   - Variables: `BASE_DOMAIN`
   - Secrets: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_ZONE_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `PULUMI_CONFIG_PASSPHRASE`, `GH_CLIENT_ID`, `GH_CLIENT_SECRET`, `GH_APP_ID`, `GH_APP_PRIVATE_KEY`, `GH_APP_SLUG`

Then push to main or manually trigger the Deploy workflow.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Your Browser                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages (UI)                         │
│                      React + Vite                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                  Cloudflare Workers (API)                        │
│                     Hono + TypeScript                            │
│  ┌──────────────┬──────────────┬──────────────┬──────────────┐  │
│  │  Workspace   │    GitHub    │     DNS      │  Cloud-Init  │  │
│  │   Service    │   Service    │   Service    │  Generator   │  │
│  └──────────────┴──────────────┴──────────────┴──────────────┘  │
└─────────────────────────────────────────────────────────────────┘
           │                │                │
           ▼                ▼                ▼
    ┌────────────┐   ┌────────────┐   ┌────────────┐
    │  Hetzner   │   │   GitHub   │   │ Cloudflare │
    │   Cloud    │   │    API     │   │    DNS     │
    └────────────┘   └────────────┘   └────────────┘
           │
           ▼
    ┌─────────────────────────────────────────────┐
    │            Hetzner Cloud VM                  │
    │  ┌─────────────────────────────────────┐    │
    │  │  Docker + DevContainer               │    │
    │  │  ┌───────────────────────────────┐  │    │
    │  │  │         Your Code             │  │    │
    │  │  └───────────────────────────────┘  │    │
    │  └─────────────────────────────────────┘    │
    │  ┌─────────────────────────────────────┐    │
    │  │  VM Agent (Go)                       │    │
    │  │  • WebSocket terminal (xterm.js)    │    │
    │  │  • JWT authentication               │    │
    │  │  • Workspace/session routing         │    │
    │  │  • Node/workspace health heartbeats  │    │
    │  └─────────────────────────────────────┘    │
    └─────────────────────────────────────────────┘
```

## Project Structure

```
apps/
├── api/              # Cloudflare Worker API (Hono)
│   └── src/
│       ├── routes/       # API endpoints
│       ├── services/     # Business logic
│       └── db/           # Database schema and migrations
└── web/              # Control Plane UI (React + Vite)
    └── src/
        ├── pages/        # Dashboard views
        ├── components/   # UI components
        └── services/     # API client

packages/
├── shared/           # Shared types and validation
├── providers/        # Cloud provider abstraction
├── cloud-init/       # VM cloud-init template generation
├── terminal/         # Shared terminal component (xterm.js + WebSocket)
└── vm-agent/         # Go agent for terminal routing, sessions, and node health

scripts/
├── vm/               # VM-side config templates (cloud-init.yaml, default-devcontainer.json)
└── deploy/           # Deployment utilities
    ├── generate-keys.ts    # Generate JWT and encryption keys
    ├── setup-github.ts     # GitHub App setup
    ├── setup-local-dev.ts  # Local development setup
    └── run-migrations.ts   # Database migrations

infra/                # Pulumi infrastructure as code
specs/                # Feature specifications
docs/                 # Documentation
```

## API Reference

### Authentication

| Endpoint       | Method | Description                      |
| -------------- | ------ | -------------------------------- |
| `/api/auth/*`  | `*`    | BetterAuth authentication routes |
| `/api/auth/me` | `GET`  | Get current user                 |

### Credentials

| Endpoint                     | Method   | Description              |
| ---------------------------- | -------- | ------------------------ |
| `/api/credentials`           | `GET`    | List credentials         |
| `/api/credentials`           | `POST`   | Create/update credential |
| `/api/credentials/:provider` | `DELETE` | Delete credential        |

### GitHub

| Endpoint                    | Method | Description                   |
| --------------------------- | ------ | ----------------------------- |
| `/api/github/installations` | `GET`  | List GitHub App installations |
| `/api/github/install-url`   | `GET`  | Get GitHub App install URL    |
| `/api/github/repositories`  | `GET`  | List accessible repositories  |
| `/api/github/webhook`       | `POST` | GitHub webhook handler        |
| `/api/github/callback`      | `GET`  | GitHub App OAuth callback     |

### Nodes

| Endpoint               | Method   | Description                     |
| ---------------------- | -------- | ------------------------------- |
| `/api/nodes`           | `GET`    | List user's nodes               |
| `/api/nodes`           | `POST`   | Create a node                   |
| `/api/nodes/:id`       | `GET`    | Get node details                |
| `/api/nodes/:id/stop`  | `POST`   | Stop a node and child workloads |
| `/api/nodes/:id`       | `DELETE` | Delete node                     |
| `/api/nodes/:id/events` | `GET`    | List node events                |

### Workspaces

| Endpoint                                         | Method   | Description                      |
| ------------------------------------------------ | -------- | -------------------------------- |
| `/api/workspaces`                                | `GET`    | List user's workspaces           |
| `/api/workspaces`                                | `POST`   | Create a new workspace           |
| `/api/workspaces/:id`                            | `GET`    | Get workspace details            |
| `/api/workspaces/:id`                            | `PATCH`  | Rename workspace display name    |
| `/api/workspaces/:id`                            | `DELETE` | Delete workspace                 |
| `/api/workspaces/:id/stop`                       | `POST`   | Stop workspace                   |
| `/api/workspaces/:id/restart`                    | `POST`   | Restart workspace                |
| `/api/workspaces/:id/events`                     | `GET`    | List workspace events            |
| `/api/workspaces/:id/agent-sessions`             | `GET`    | List agent sessions              |
| `/api/workspaces/:id/agent-sessions`             | `POST`   | Create agent session             |
| `/api/workspaces/:id/agent-sessions/:sessionId/stop` | `POST` | Stop agent session               |
| `/api/workspaces/:id/ready`                      | `POST`   | Workspace ready callback         |
| `/api/workspaces/:id/heartbeat`                  | `POST`   | Workspace heartbeat callback     |

### Terminal

| Endpoint                 | Method | Description               |
| ------------------------ | ------ | ------------------------- |
| `/api/terminal/token`    | `POST` | Get terminal access token |
| `/.well-known/jwks.json` | `GET`  | JWKS for JWT verification |

### VM Agent

| Endpoint                    | Method | Description                                |
| --------------------------- | ------ | ------------------------------------------ |
| `/api/agent/download`       | `GET`  | Download VM agent binary (query: os, arch) |
| `/api/agent/version`        | `GET`  | Get current agent version                  |
| `/api/agent/install-script` | `GET`  | Get VM agent install script                |

### Bootstrap (VM Credential Delivery)

| Endpoint                | Method | Description                                     |
| ----------------------- | ------ | ----------------------------------------------- |
| `/api/bootstrap/:token` | `POST` | Redeem one-time bootstrap token for credentials + git identity |

Authentication is session-based via cookies (BetterAuth + GitHub OAuth).

## Security

### Secure Credential Delivery (Bootstrap Tokens)

VMs receive credentials securely using one-time bootstrap tokens:

1. **Workspace creation**: API generates a one-time bootstrap token stored in KV with 5-minute TTL
2. **Cloud-init**: VM receives only the bootstrap URL (no embedded secrets)
3. **VM startup**: VM agent calls `POST /api/bootstrap/:token` to redeem credentials and git identity
4. **Token invalidation**: Token is deleted immediately after first use

This ensures:

- No sensitive tokens in cloud-init user data (visible in Hetzner console)
- Single-use tokens prevent replay attacks
- Short TTL limits exposure window
- Devcontainer git author identity is set from authenticated user profile data

### Workspace Access Control

All workspace operations validate ownership to prevent IDOR attacks:

- Non-owners receive `404 Not Found` (not `403 Forbidden`) to prevent information disclosure
- Workspace lists are filtered by authenticated user
- Terminal WebSocket tokens are scoped to workspace owner

## Use Cases

### Instant Prototyping

Spin up a workspace to try a new library without polluting your local environment. Claude Code is ready to help you explore and implement.

```bash
# Create workspace via web UI or API
# Authentication is handled via GitHub OAuth session
curl -X POST https://api.example.com/api/workspaces \
  -H "Content-Type: application/json" \
  --cookie "session=..." \
  -d '{"name": "my-workspace", "repository": "user/repo", "installationId": "...", "vmSize": "medium"}'
```

### Private Codebase Development

Connect your GitHub organization, create workspaces from private repositories, and let Claude help with refactoring while keeping everything in ephemeral environments.

### Team Onboarding

New team members can spin up fully configured development environments in minutes—no local setup required.

## Roadmap

| Phase                   | Target   | Features                                               |
| ----------------------- | -------- | ------------------------------------------------------ |
| **1. MVP**              | Complete | Core workspace management and GitHub OAuth             |
| **2. Browser Terminal** | Current  | Web terminal, VM agent, multi-workspace nodes/sessions |
| **3. Enhanced UX**      | Q1 2026  | Logs, SSH access, templates, persistent storage        |
| **4. Multi-Tenancy**    | Q2 2026  | Teams, usage quotas, billing                           |
| **5. Enterprise**       | Q3 2026  | VPC, SSO, compliance, multi-region                     |

See [ROADMAP.md](ROADMAP.md) for details.

## Tech Stack

| Component          | Technology                                                                                                                                                                          |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API Runtime**    | [Cloudflare Workers](https://workers.cloudflare.com/)                                                                                                                               |
| **API Framework**  | [Hono](https://hono.dev/)                                                                                                                                                           |
| **Web UI**         | [React](https://react.dev/) + [Vite](https://vitejs.dev/)                                                                                                                           |
| **Cloud Provider** | [Hetzner Cloud](https://hetzner.cloud/)                                                                                                                                             |
| **DNS**            | [Cloudflare DNS](https://cloudflare.com/)                                                                                                                                           |
| **Data Storage**   | [Cloudflare D1](https://developers.cloudflare.com/d1/) (database) + [KV](https://developers.cloudflare.com/kv/) (sessions) + [R2](https://developers.cloudflare.com/r2/) (binaries) |
| **Testing**        | [Vitest](https://vitest.dev/) + [Miniflare](https://miniflare.dev/)                                                                                                                 |
| **Monorepo**       | [pnpm](https://pnpm.io/) + [Turborepo](https://turbo.build/)                                                                                                                        |

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
# Setup development environment
pnpm install

# Run tests before submitting
pnpm test
pnpm typecheck

# Format code
pnpm format
```

## Related Projects

- [DevPod](https://github.com/loft-sh/devpod) — Client-only devcontainer management
- [Coder](https://github.com/coder/coder) — Self-hosted cloud development environments
- [Daytona](https://github.com/daytonaio/daytona) — Open source dev environment manager

## License

[MIT](LICENSE)

---

<p align="center">
  Built with <a href="https://hono.dev/">Hono</a> on <a href="https://cloudflare.com/">Cloudflare</a>
</p>
