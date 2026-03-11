# Launch Announcement: SAM — Open Source AI Agent Infrastructure

**Source**: `strategy/marketing/positioning.md`, `strategy/marketing/messaging-guide.md`
**Key Message**: Run AI coding agents on your own cloud.
**CTA**: Star the repo / Try self-hosting

---

## LinkedIn (Professional, longer-form)

### Variant A: Problem-focused

Every AI coding agent platform wants you on their cloud, with their infrastructure, under their pricing.

But what if you want AI agents AND control?

We've been building SAM — an open-source platform that lets you run AI coding agents (starting with Claude Code) on your own cloud infrastructure.

How it works:
- You provide your cloud account (Hetzner today, more providers coming)
- SAM handles orchestration — provisioning workspaces, managing agent sessions, turning tasks into pull requests
- The control plane runs serverless on Cloudflare Workers
- Everything is self-hostable. No vendor lock-in.

The key insight: the value of AI coding agents increases when you control the infrastructure they run on. Your credentials, your costs, your data.

We're calling this BYOC — Bring Your Own Cloud. And it's open source.

What would you build if your AI agents ran on infrastructure you controlled?

[Link to repo]

### Variant B: Announcement-focused

Announcing SAM — open-source infrastructure for running AI coding agents on your own cloud.

Think of it as the self-hosted control plane for autonomous coding. Submit a task in chat, get a pull request back. Your cloud, your credentials, your control.

Built on Cloudflare Workers. BYOC model. Currently supports Claude Code on Hetzner, with more agents and providers on the roadmap.

[Link to repo]

---

## Twitter/X Thread

### Variant A

1/ We've been building SAM — open-source infrastructure for running AI coding agents on your own cloud.

BYOC (Bring Your Own Cloud). Self-hostable. No vendor lock-in.

Here's why this matters:

2/ Every AI coding platform wants you on THEIR infrastructure. Your code on their servers. Your costs on their pricing.

SAM flips this. You bring your cloud account. SAM orchestrates the agents.

3/ How it works:
- Chat-first UI — submit a task, get a PR
- Ephemeral workspaces on your VMs
- Claude Code as the agent (more coming)
- Control plane is serverless on Cloudflare Workers
- Credentials encrypted per-user, never leave your infra

4/ The stack:
- TypeScript + Hono on Cloudflare Workers
- Go VM agent for PTY/WebSocket/agent management
- React + Vite frontend
- D1 + Durable Objects for storage
- Pulumi for deployment

Fully self-hostable.

5/ Currently supports Hetzner Cloud. Multi-provider (DigitalOcean, Vultr, GCP) is on the roadmap.

Open source. Star the repo, try self-hosting, or just come lurk.

[Link]

### Single Tweet Variant

SAM: open-source platform for running AI coding agents on your own cloud. BYOC, self-hostable, chat-first. Submit a task, get a PR. Currently supports Claude Code + Hetzner. [Link]

---

## Hacker News

### Title Options

1. "Show HN: SAM – Open-source BYOC infrastructure for AI coding agents"
2. "Show HN: SAM – Run Claude Code on your own cloud with a chat-first UI"
3. "Show HN: Self-hosted platform for autonomous AI coding agents"

### Comment

We built SAM because we wanted AI coding agents running on infrastructure we controlled.

The architecture: a serverless control plane on Cloudflare Workers that orchestrates ephemeral workspaces on your own cloud (Hetzner today). You provide your API token, SAM provisions VMs, sets up devcontainers, and runs Claude Code sessions. Chat interface for task submission — you describe what you want, the agent produces a PR.

Key design decisions:
- BYOC (Bring Your Own Cloud) — SAM never holds your cloud credentials. They're encrypted per-user in D1.
- Serverless control plane — Workers + Durable Objects + D1. Scales to zero.
- Full VM isolation — not containers or sandboxes. Each workspace gets a real VM with a devcontainer.
- Warm node pooling — nodes stay warm for 30 minutes after a task completes for fast reuse.

Trade-offs we're honest about:
- Provisioning is minutes, not milliseconds (Daytona does 90ms). Warm pooling helps but cold starts are slow.
- Hetzner only for now. Multi-provider is the next priority.
- Single agent type (Claude Code). Multi-agent is on the roadmap.

Stack: TypeScript/Hono (API), Go (VM agent), React/Vite (web), Cloudflare D1 + Durable Objects (storage), Pulumi (deploy).

Happy to answer questions about the architecture or take feedback.

---

## Reddit

### r/selfhosted

**Title**: SAM — self-hosted platform for running AI coding agents on your own cloud

**Post**:

Built an open-source platform for running AI coding agents (Claude Code) in ephemeral cloud environments. The control plane is self-hostable on Cloudflare Workers, and you bring your own cloud account for the VMs.

**What it does**: Submit a coding task via chat, SAM provisions a workspace on your Hetzner account, runs Claude Code, and produces a PR. Credentials stay encrypted on your infrastructure.

**Self-hosting**: Full Cloudflare Workers deployment via Pulumi. You need a Cloudflare account (Workers, D1, KV, R2) and a Hetzner token.

**Not a managed service** — there's no SAM Cloud (yet). This is fully self-hosted. Your cloud, your data, your control.

Currently Hetzner-only for VMs. Multi-provider coming.

[Link to repo and self-hosting guide]

### r/ClaudeAI

**Title**: Open-source platform for running Claude Code autonomously on cloud VMs

**Post**:

If you're using Claude Code and want to run it on cloud VMs instead of your local machine — we built SAM for this. Submit tasks via a chat interface, and Claude Code runs in ephemeral workspaces on your own Hetzner account.

Features relevant to Claude Code users:
- OAuth token support (Claude Max/Pro subscriptions)
- Agent session persistence — survives browser disconnects
- Automatic git push + PR creation when tasks complete
- Per-user encrypted credential storage

Self-hosted, open source. Not a managed service.

[Link]
