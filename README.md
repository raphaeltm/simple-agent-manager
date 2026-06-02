<p align="center">
  <img src="assets/images/sam-banner.png" alt="Simple Agent Manager" width="400" />
</p>

<p align="center">
  <strong>Describe what you want built. SAM provisions a cloud workspace, runs an AI coding agent, and streams the results back to you.</strong>
</p>

<p align="center">
  <a href="https://simple-agent-manager.org/docs/guides/self-hosting/">Self-Hosting Guide</a> &bull;
  <a href="https://simple-agent-manager.org/docs/architecture/overview/">Architecture</a> &bull;
  <a href="https://simple-agent-manager.org/docs/">Documentation</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3%2B-blue?style=flat-square" alt="License" /></a>
</p>

---

## What You Get

**Project chat that executes code.** Link a GitHub repo, describe a task in natural language, and SAM handles the rest — provisioning a VM, cloning your repo into a devcontainer, starting [Claude Code](https://www.anthropic.com/claude-code), and streaming output back to the chat.

**Chat history that outlives workspaces.** Conversations persist at the project level. Stop a workspace, spin up a new one weeks later, and your full history is still there.

**Your infrastructure, your costs.** Self-hosted on Cloudflare (free tier) + Hetzner Cloud VMs. A workspace costs ~$0.007–0.03/hr compared to $0.18–0.36/hr on GitHub Codespaces.

## How It Works

```
You: "Add rate limiting to the /api/upload endpoint"
         |
    Project Chat (app.{domain})
         |
    Cloudflare Worker API
         |
    TaskRunner -- alarm-driven orchestrator that:
      1. Claims a warm node or provisions a new Hetzner VM
      2. Creates a Docker workspace with your repo
      3. Starts Claude Code with your task description
      4. Streams agent output back to project chat
         |
    Agent streams results back as it works
```

## Architecture

| Layer | What | How |
|-------|------|-----|
| **Control plane** | API, auth, orchestration | Cloudflare Workers + D1 + KV + R2 |
| **Real-time data** | Chat messages, activity, sessions | Durable Objects with embedded SQLite (per project) |
| **Compute** | Workspaces running coding agents | Hetzner VMs with a Go agent managing Docker containers, WebSocket terminal, and auth |
| **Warm pool** | Fast workspace starts | Completed VMs stay warm for 30 min for instant reuse |

The control plane is serverless — no servers to manage, no databases to back up. Compute scales to zero when you're not using it.

### Repository Structure

```
apps/
  api/          Cloudflare Worker API (Hono)
  web/          Control plane UI (React + Vite)
  www/          Marketing site, blog & docs (Astro + Starlight)
packages/
  shared/       Shared types and utilities
  providers/    Cloud provider abstraction (Hetzner)
  cloud-init/   Cloud-init template generator
  vm-agent/     Go VM agent (PTY, WebSocket, MCP tool endpoints)
  ui/           Design system tokens and shared UI components
  terminal/     Shared terminal component
```

For the full architecture with diagrams, see the **[Architecture Overview](https://simple-agent-manager.org/docs/architecture/overview/)**.

## Quick Deploy

SAM deploys automatically via GitHub Actions. Fork, configure, push. For the complete setup guide with detailed steps and troubleshooting, see the **[Self-Hosting Guide](https://simple-agent-manager.org/docs/guides/self-hosting/)**.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A domain with nameservers pointing to Cloudflare
- A [GitHub App](https://simple-agent-manager.org/docs/guides/self-hosting/#github-setup) for OAuth + repo access

### Steps

1. **Fork this repository**
2. **Create a GitHub Environment** named `production` in your fork's Settings > Environments
3. **Add the required secrets** (Cloudflare API token, GitHub App credentials, etc. — see the [Self-Hosting Guide](https://simple-agent-manager.org/docs/guides/self-hosting/) for the full list)
4. **Push to `main`** — GitHub Actions provisions all infrastructure, deploys the API + UI, runs migrations, and verifies health

Your instance is live at `app.{your-domain}`. Users sign in with GitHub and provide their own Hetzner API token to create workspaces.

## Development

```bash
pnpm install        # Install dependencies
pnpm build          # Build all packages
pnpm test           # Run tests
pnpm typecheck      # Type check
pnpm lint           # Lint
pnpm format         # Format
```

Build packages in dependency order: `shared` > `providers` > `cloud-init` > `api` / `web`.

For local development details, see the **[Local Development Guide](https://simple-agent-manager.org/docs/guides/local-development/)**.

## Documentation

Full documentation is available at **[simple-agent-manager.org/docs](https://simple-agent-manager.org/docs/)**:

- [Self-Hosting Guide](https://simple-agent-manager.org/docs/guides/self-hosting/) — deploy your own instance
- [Architecture Overview](https://simple-agent-manager.org/docs/architecture/overview/) — how the system works
- [Security Model](https://simple-agent-manager.org/docs/architecture/security/) — BYOC, encryption, credentials
- [Local Development](https://simple-agent-manager.org/docs/guides/local-development/) — contributing and development setup

## License

[AGPL-3.0](LICENSE)
