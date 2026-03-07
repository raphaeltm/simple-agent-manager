---
title: Architecture Overview
description: How SAM's components fit together — from the browser to the VM terminal.
---

SAM is a serverless platform for ephemeral AI coding environments. The architecture splits into three layers: **edge** (Cloudflare), **compute** (Hetzner VMs), and **external services** (GitHub, DNS).

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      Browser                             │
│  React SPA (app.domain) ──── xterm.js ──── Agent Chat   │
└─────────┬───────────────────────┬───────────────────────┘
          │ HTTPS                 │ WSS
          ▼                       ▼
┌─────────────────────────────────────────────────────────┐
│                  Cloudflare Edge                         │
│                                                          │
│  ┌─────────────┐  ┌──────┐  ┌────┐  ┌────┐             │
│  │ API Worker   │  │  D1  │  │ KV │  │ R2 │             │
│  │ (Hono)       │──│SQLite│  │    │  │    │             │
│  │              │  └──────┘  └────┘  └────┘             │
│  │ + Proxy      │                                        │
│  │ + Auth       │  ┌──────────────────────┐             │
│  │ + DOs        │  │ Cloudflare Pages     │             │
│  └──────┬───────┘  │ (React SPA)          │             │
│         │          └──────────────────────┘             │
└─────────┼───────────────────────────────────────────────┘
          │ HTTP/WSS (proxied via DNS-only records)
          ▼
┌─────────────────────────────────────────────────────────┐
│                  Hetzner Cloud VM                        │
│                                                          │
│  ┌───────────────────────────────────────┐              │
│  │ VM Agent (Go, :8080)                  │              │
│  │  ├── PTY Manager (terminal sessions)  │              │
│  │  ├── Container Manager (Docker)       │              │
│  │  ├── ACP Gateway (Claude Code)        │              │
│  │  └── JWT Validator (JWKS)             │              │
│  └───────────────┬───────────────────────┘              │
│                  │                                       │
│  ┌───────────────▼───────────────────────┐              │
│  │ Docker Engine                          │              │
│  │  ├── Workspace Container 1             │              │
│  │  └── Workspace Container N             │              │
│  └───────────────────────────────────────┘              │
└─────────────────────────────────────────────────────────┘
```

## Request Routing

Every request to `*.domain` passes through the same Cloudflare Worker. The `Host` header determines routing:

| Pattern | Destination | How |
|---------|-------------|-----|
| `app.{domain}` | Cloudflare Pages | Worker proxies to `{project}.pages.dev` |
| `api.{domain}` | Worker API routes | Direct handling by Hono router |
| `ws-{id}.{domain}` | VM Agent on port 8080 | Worker proxies via DNS-only `vm-{nodeId}.{domain}` |
| `*.{domain}` (other) | 404 | No matching route |

:::note[Why DNS-only backend hostnames?]
Cloudflare Workers can't fetch IP addresses directly (Error 1003). Non-proxied DNS A records (`vm-{nodeId}.{domain}` → VM IP) are created so the Worker can proxy through hostnames.
:::

## Control Plane — API Worker

The API Worker (`apps/api/`) is a Hono application handling:

- **Authentication** — GitHub OAuth via BetterAuth
- **Resource management** — CRUD for nodes, workspaces, projects
- **Reverse proxy** — workspace subdomain traffic to VMs
- **Durable Objects** — per-project chat data (ProjectData DO), node lifecycle (NodeLifecycle DO)
- **Cron triggers** — provisioning timeout checks every 5 minutes

### Key Route Groups

| Route | Purpose |
|-------|---------|
| `/api/auth/*` | GitHub OAuth sign-in/out, sessions |
| `/api/nodes/*` | Node CRUD, lifecycle, health callbacks |
| `/api/workspaces/*` | Workspace CRUD, lifecycle, boot logs, agent sessions |
| `/api/credentials/*` | Cloud provider + agent API key management |
| `/api/github/*` | GitHub App installations, repos |
| `/api/terminal/token` | Workspace JWT for WebSocket auth |
| `/api/agent/*` | VM Agent binary download |
| `/api/bootstrap/:token` | One-time credential injection |

## Data Layer

| Service | Binding | Purpose |
|---------|---------|---------|
| **D1 (SQLite)** | `DATABASE` | Users, nodes, workspaces, credentials, sessions |
| **D1** | `OBSERVABILITY_DATABASE` | Error storage for admin dashboard |
| **KV** | `KV` | Auth sessions, bootstrap tokens, boot logs |
| **R2** | `R2` | VM Agent binaries, Pulumi state |
| **Durable Objects** | `PROJECT_DATA` | Per-project chat sessions, messages, activity |
| **Durable Objects** | `NODE_LIFECYCLE` | Per-node warm pool state machine |

## VM Agent

The VM Agent (`packages/vm-agent/`) is a Go binary running on each node:

| Subsystem | Package | Responsibility |
|-----------|---------|---------------|
| PTY Manager | `internal/pty/` | Terminal multiplexing, ring buffer replay |
| Container Manager | `internal/container/` | Docker exec, devcontainer CLI |
| ACP Gateway | `internal/acp/` | Claude Code protocol, streaming responses |
| JWT Validator | `internal/auth/` | Validates workspace JWTs via JWKS endpoint |
| Persistence | `internal/persistence/` | SQLite tab storage |
| Boot Logger | `internal/bootlog/` | Reports provisioning progress |

## Deployment Pipeline

```
Push to main
  │
  ├── Phase 1: Infrastructure (Pulumi)
  │     └── D1, KV, R2, DNS records
  │
  ├── Phase 2: Configuration
  │     └── Sync wrangler.toml, read security keys
  │
  ├── Phase 3: Application
  │     └── Build → Deploy Worker → Deploy Pages → Migrations → Secrets
  │
  ├── Phase 4: VM Agent
  │     └── Build Go (multi-arch) → Upload to R2
  │
  └── Phase 5: Validation
        └── Health check polling
```

CI runs lint, typecheck, tests, and build on every push. The deploy workflow only triggers on pushes to `main`.

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Single Worker as API + reverse proxy | Simplifies infrastructure — one Worker handles everything |
| D1 for persistent state | SQLite at the edge with zero management |
| User-provided Hetzner tokens (BYOC) | Users own their infrastructure and costs |
| Callback-driven provisioning | VMs POST `/ready` when bootstrapped — no polling |
| Dynamic DNS per workspace | Instant subdomain resolution; cleaned up on stop |
| Durable Objects for chat data | High-throughput writes without D1 contention |
| No credentials in cloud-init | Bootstrap tokens for secure credential injection |
