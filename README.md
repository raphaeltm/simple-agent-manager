<p align="center">
  <img src="assets/images/sam-banner.png" alt="Simple Agent Manager" width="400" />
</p>

<p align="center">
  <strong>Describe what you want built. SAM provisions a cloud workspace, runs an AI coding agent, and streams the results back to you.</strong>
</p>

<p align="center">
  <a href="#quick-deploy">Quick Deploy</a> •
  <a href="docs/guides/self-hosting.md">Self-Hosting Guide</a> •
  <a href="docs/architecture/walkthrough.md">Architecture</a> •
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3%2B-blue?style=flat-square" alt="License" /></a>
</p>

---

## What You Get

**Project chat that executes code.** Link a GitHub repo, describe a task in natural language, and SAM handles the rest — provisioning a VM, cloning your repo into a devcontainer, starting [Claude Code](https://www.anthropic.com/claude-code), and streaming output back to the chat. When the agent finishes, it pushes to a branch and opens a PR.

**Chat history that outlives workspaces.** Conversations persist at the project level. Stop a workspace, spin up a new one weeks later, and your full history is still there.

**Your infrastructure, your costs.** Self-hosted on Cloudflare (free tier) + Hetzner Cloud VMs. A workspace costs ~$0.007–0.03/hr compared to $0.18–0.36/hr on GitHub Codespaces.

## How It Works

```
You: "Add rate limiting to the /api/upload endpoint"
         ↓
    Project Chat (app.{domain})
         ↓
    Cloudflare Worker API
         ↓
    TaskRunner — alarm-driven orchestrator that:
      1. Claims a warm node or provisions a new Hetzner VM
      2. Creates a Docker workspace with your repo
      3. Starts Claude Code with your task description
      4. Streams agent output back to project chat
         ↓
    Agent pushes branch + opens PR when done
```

### Architecture

| Layer | What | How |
|-------|------|-----|
| **Control plane** | API, auth, orchestration | Cloudflare Workers + D1 + KV + R2 |
| **Real-time data** | Chat messages, activity, sessions | Durable Objects with embedded SQLite (per project) |
| **Compute** | Workspaces running Claude Code | Hetzner VMs with a Go agent managing Docker containers, WebSocket terminal, and auth |
| **Warm pool** | Fast workspace starts | Completed VMs stay warm for 30 min for instant reuse |

The control plane is serverless — no servers to manage, no databases to back up. Compute scales to zero when you're not using it.

For the full architecture with Mermaid diagrams, see the **[Architecture Walkthrough](docs/architecture/walkthrough.md)**.

## Quick Deploy

SAM deploys automatically via GitHub Actions. Fork, configure, push.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier works)
- A domain with nameservers pointing to Cloudflare
- A [GitHub App](docs/guides/self-hosting.md#github-setup) for OAuth + repo access

### Steps

**1. Fork this repository**

**2. Create a GitHub Environment** named `production` in your fork's Settings → Environments

**3. Add environment variables:**

| Variable | Example |
|----------|---------|
| `BASE_DOMAIN` | `example.com` |

**4. Add environment secrets:**

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token ([required permissions](docs/guides/self-hosting.md#step-4-create-api-token-with-required-permissions)) |
| `CF_ACCOUNT_ID` | Cloudflare account ID |
| `CF_ZONE_ID` | Cloudflare zone ID |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key |
| `PULUMI_CONFIG_PASSPHRASE` | `openssl rand -base64 32` |
| `GH_CLIENT_ID` | GitHub App client ID |
| `GH_CLIENT_SECRET` | GitHub App client secret |
| `GH_APP_ID` | GitHub App ID |
| `GH_APP_PRIVATE_KEY` | GitHub App private key (raw PEM or base64) |
| `GH_APP_SLUG` | GitHub App URL slug |

> Security keys (JWT, encryption) are generated automatically on first deploy.

**5. Push to `main`** — GitHub Actions provisions all infrastructure, deploys the API + UI, runs migrations, and verifies health.

Your instance is live at `app.{your-domain}`. Users sign in with GitHub and provide their own Hetzner API token to create workspaces.

For detailed setup, troubleshooting, and manual deployment: **[Self-Hosting Guide](docs/guides/self-hosting.md)**.

## Development

```bash
pnpm install        # Install dependencies
pnpm dev            # Start dev servers (API + Web)
pnpm test           # Run tests
pnpm typecheck      # Type check
pnpm build          # Build all packages
```

> Local dev has limitations (no real OAuth, DNS, or VMs). For full testing, deploy to staging. See [Local Development Guide](docs/guides/local-development.md).

## Contributing

Contributions welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
