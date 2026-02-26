---
title: "Introducing SAM: AI Coding Environments on Your Own Cloud"
date: 2026-02-25
author: SAM Team
category: announcement
tags: ["launch", "open-source", "ai-agents", "cloudflare-workers"]
excerpt: "SAM gives you ephemeral AI coding environments backed by your own Hetzner cloud account. Spin up Claude Code in a devcontainer, chat with your agent, and tear it down when you're done."
---

We've been building SAM — Simple Agent Manager — over the past month, and today we're sharing what it is and why we built it.

## The problem

Running AI coding agents like Claude Code requires compute. You can run them locally, but that ties up your machine. You can use hosted solutions, but then you're trusting someone else with your code and your cloud credentials.

We wanted something in between: a platform that manages the orchestration — spinning up VMs, configuring devcontainers, connecting you to your agent — but runs everything on **your own cloud account**. You bring your Hetzner API token. We never see it unencrypted.

## What SAM does

SAM is a control plane for ephemeral AI coding environments. Here's the flow:

1. **Connect your cloud** — Provide your Hetzner API token (encrypted with AES-256-GCM, stored per-user)
2. **Create a project** — Link a GitHub repo
3. **Chat** — Type a message describing what you want built. SAM provisions a VM, sets up a devcontainer with Claude Code, and streams the agent's work back to you in real time
4. **Review and merge** — When the agent finishes, it pushes a branch and opens a PR
5. **Clean up** — Stop or delete the workspace when you're done. Or let warm pooling reuse the node for your next task

The entire platform runs on Cloudflare Workers — the API, the real-time WebSocket connections, the Durable Objects managing per-project state. The only "servers" are the Hetzner VMs your agents run on, and those are yours.

## Architecture highlights

A few decisions that shaped the project:

### Bring Your Own Cloud (BYOC)

SAM never has cloud provider credentials. Your Hetzner token is encrypted at rest using AES-256-GCM with a unique initialization vector per credential, then stored in D1 scoped to your user account. The platform encryption key is a Cloudflare Worker secret — it never touches application code as a variable.

### Hybrid storage: D1 + Durable Objects

We use Cloudflare D1 for cross-project queries (dashboard, user settings, task lists) and per-project Durable Objects with embedded SQLite for write-heavy data (chat sessions, messages, activity streams). This gives us the query flexibility of a relational database and the single-writer guarantees of DOs. We wrote about the tradeoffs in [ADR 004](https://github.com/raphaeltm/simple-agent-manager/blob/main/docs/adr/004-hybrid-d1-do-storage.md).

### Warm node pooling

Cold-starting a VM takes a couple of minutes. For interactive use, that's too slow. After a task completes, SAM keeps the node "warm" for 30 minutes (configurable). If you submit another task, it reuses the warm node — bringing startup time down to seconds. A three-layer defense (DO alarm + cron sweep + max lifetime) ensures no orphaned VMs run indefinitely.

### Chat-first UX

Our interface went through three iterations. We started with a dashboard of tabs (overview, tasks, sessions, settings). Then we realized: developers don't think in terms of "manage my task queue." They think "I have a repo, go do something." So we collapsed everything into a single chat interface. One text box. Type what you want, and the system figures out the rest.

## What's next

SAM is early. There's a lot we want to build:

- **Multi-provider support** — AWS, GCP, and other cloud providers beyond Hetzner
- **Team workspaces** — Shared projects with role-based access
- **Better observability** — Node-level logs, metrics, and health dashboards
- **Content and tutorials** — This blog is the start

If you're building AI tooling, working with Cloudflare Workers, or just interested in how we put this together, follow along. We'll be writing about the engineering decisions, the bugs, and the things we learned building a serverless AI agent platform in 30 days.

## Try it out

SAM is open source. You can self-host it or use the hosted version at [app.simple-agent-manager.org](https://app.simple-agent-manager.org). All you need is a GitHub account and a Hetzner API token.
