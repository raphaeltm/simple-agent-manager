<p align="center">
  <img src="assets/images/sam-banner.png" alt="Simple Agent Manager" width="400" />
</p>

<p align="center">
  <strong>Run AI coding agents in parallel on your own cloud.</strong>
</p>

<p align="center">
  Every agent gets its own isolated container on a VM billed to <em>your</em> cloud account — full Linux, Docker + git, reachable in the browser. Run 5 or 500 at once.
</p>

<p align="center">
  <a href="https://app.simple-agent-manager.org">Try it</a> &bull;
  <a href="https://github.com/raphaeltm/simple-agent-manager">Star on GitHub</a> &bull;
  <a href="https://simple-agent-manager.org/docs/">Documentation</a> &bull;
  <a href="https://simple-agent-manager.org/docs/guides/self-hosting/">Self-Hosting Guide</a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL_v3%2B-blue?style=flat-square" alt="License" /></a>
  <a href="https://app.codspeed.io/raphaeltm/simple-agent-manager?utm_source=badge"><img src="https://img.shields.io/endpoint?url=https://codspeed.io/badge.json" alt="CodSpeed"/></a>
</p>

<p align="center">
  <img src="assets/images/sam-screenshot-byoc.webp" alt="SAM nodes and workspaces dashboard" width="760" />
</p>

---

## What You Get

**Agents in parallel, each in a real environment.** Every agent runs in its own isolated Docker container on a VM you own — full Linux, Docker, and git, reachable from any browser. Run a handful or hundreds at once, each in a clean workspace.

**Bring your own cloud.** VMs are provisioned in your own Hetzner, Scaleway, or GCP account and billed directly to you. SAM never stores your cloud provider credentials as platform env vars — they're encrypted per-user. Your agents, your infra, your data.

**Bring your own agent.** Six harnesses work today: [Claude Code](https://www.anthropic.com/claude-code), Codex, Gemini, Mistral, OpenCode, and Amp. Use your own API key, your OAuth/subscription token, or the platform proxy.

**Chat-first, and it outlives workspaces.** Link a GitHub repo, describe a task in natural language, and watch every tool call stream back. Conversations persist at the project level — stop a workspace, spin up a new one weeks later, and your full history is still there.

**Serverless control plane.** Self-hosted on Cloudflare ($5/mo Workers Paid plan) — the control plane provisions, schedules, and tears down workspaces with nothing to babysit. A workspace costs ~$0.007–0.03/hr compared to $0.18–0.36/hr on GitHub Codespaces.

<p align="center">
  <img src="assets/images/sam-screenshot-chat.webp" alt="SAM live agent session with tool stream" width="760" />
</p>

## How It Works

```
You: "Add rate limiting to the /api/upload endpoint"
         |
    Project Chat (app.{domain})
         |
    Cloudflare Worker API
         |
    TaskRunner -- alarm-driven orchestrator that:
      1. Claims a warm node or provisions a new VM in your cloud
      2. Creates a Docker workspace with your repo
      3. Starts your chosen agent with the task description
      4. Streams agent output back to project chat
         |
    Agent streams results back as it works
```

## Architecture

| Layer              | What                              | How                                                                                                                        |
| ------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Control plane**  | API, auth, orchestration          | Cloudflare Workers + D1 + KV + R2                                                                                          |
| **Real-time data** | Chat messages, activity, sessions | Durable Objects with embedded SQLite (per project)                                                                         |
| **Compute**        | Workspaces running coding agents  | VMs in your own cloud (Hetzner, Scaleway, or GCP) with a Go agent managing Docker containers, WebSocket terminal, and auth |
| **Warm pool**      | Fast workspace starts             | Completed VMs stay warm for 30 min for instant reuse                                                                       |

The control plane is serverless — no servers to manage, no databases to back up. Compute scales to zero when you're not using it.

### Repository Structure

```
apps/
  api/          Cloudflare Worker API (Hono)
  web/          Control plane UI (React + Vite)
  www/          Marketing site, blog & docs (Astro + Starlight)
packages/
  shared/       Shared types and utilities
  providers/    Cloud provider abstraction (Hetzner, Scaleway, GCP)
  cloud-init/   Cloud-init template generator
  vm-agent/     Go VM agent (PTY, WebSocket, MCP tool endpoints)
  ui/           Design system tokens and shared UI components
  terminal/     Shared terminal component
```

For the full architecture with diagrams, see the **[Architecture Overview](https://simple-agent-manager.org/docs/architecture/overview/)**.

## Quick Deploy

SAM deploys through the **Deploy Production** GitHub Actions workflow in your fork. Fork, configure the `production` environment, then run the workflow manually. For the complete setup guide with detailed steps and troubleshooting, see the **[Self-Hosting Guide](https://simple-agent-manager.org/docs/guides/self-hosting/)**.

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (Workers Paid plan, $5/mo) with a token that includes Containers permission
- A domain with nameservers pointing to Cloudflare
- A [GitHub App](https://simple-agent-manager.org/docs/guides/self-hosting/#github-setup) for OAuth + repo access

### Steps

1. **Fork this repository**
2. **Create a GitHub Environment** named `production` in your fork's Settings > Environments
3. **Add the required secrets** (Cloudflare API token with `Containers: Edit`, GitHub App credentials, etc. — see the [Self-Hosting Guide](https://simple-agent-manager.org/docs/guides/self-hosting/) for the full list)
4. **Run Actions → Deploy Production → Run workflow** on `main` — GitHub Actions provisions all infrastructure, deploys the API + UI, runs migrations, and verifies health

To update an existing self-hosted instance, sync upstream changes into your fork's `main` branch, then manually run **Deploy Production** again.

Your instance is live at `app.{your-domain}`. Users sign in with GitHub and provide their own cloud provider API token (Hetzner, Scaleway, or GCP) to create workspaces.

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
