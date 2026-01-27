# Cloud AI Coding Workspaces - Research Documentation

This folder contains research and planning documents for a lightweight, serverless platform to spin up AI coding agent environments on-demand.

## Project Vision

**"GitHub Codespaces, but optimized for Claude Code and AI-assisted development."**

Key differentiators from generic devcontainer orchestrators:
- First-class Claude Code support (pre-installed, session persistence)
- API key management (secure input, storage, injection)
- Agent-aware idle detection (don't shutdown while Claude is working)
- Zero ongoing cost (VMs self-terminate, serverless control plane)
- Multi-tenant ready architecture (designed for future BYOC)

---

## Document Index

### 1. [Architecture Notes](./architecture-notes.md)
**Start here.** High-level overview of the system architecture, provider comparison, and core concepts.

Contents:
- Goals and requirements
- Provider comparison (Hetzner, Scaleway, OVH)
- System architecture diagram
- Self-terminating VM mechanism
- Provider abstraction interface
- Claude Code web UI options (CUI, CloudCLI, etc.)
- Cost analysis

### 2. [AI Agent Optimizations](./ai-agent-optimizations.md)
**Implementation details.** Purpose-built optimizations for AI coding workflows.

Contents:
- Claude Code devcontainer feature setup
- First-class API key management flow
- `~/.claude` persistence strategy
- CLAUDE.md auto-generation script
- MCP server pre-configuration
- Agent-aware idle detection script
- Default devcontainer.json template

### 3. [DNS, Security & Persistence](./dns-security-persistence-plan.md)
**Infrastructure planning.** Detailed plans for networking, security, and data persistence.

Contents:
- DNS options (Wildcard DNS vs Cloudflare Tunnels)
- Cloudflare R2 storage architecture
- Encryption strategy (workspace keys, tenant keys)
- Caddy reverse proxy configuration
- Port discovery mechanism
- Implementation phases (MVP → Enhanced Security)

### 4. [Multi-Tenancy Interfaces](./multi-tenancy-interfaces.md)
**Future-proofing.** Interface designs that support multi-tenancy from day one.

Contents:
- Multi-tenancy models (Shared, BYOC, Hybrid)
- RequestContext, Tenant, Provider interfaces
- DNS and Storage abstraction interfaces
- Encryption key hierarchy
- Migration path from single to multi-tenant

---

## Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary Provider | Hetzner CX22 | Best value (€5.39/mo, 4GB RAM) |
| Web UI | CloudCLI | File explorer + terminal integration |
| Control Plane | Cloudflare Pages + Workers | Serverless, free tier |
| Storage | Cloudflare R2 | S3-compatible, no egress fees |
| DNS (MVP) | Wildcard DNS | Simple, fast (~1min propagation) |
| DNS (Future) | Cloudflare Tunnels | Enables user-registered runners |
| Auth (MVP) | Bearer token | Single user, env var |
| Auth (Future) | JWT | Multi-tenant ready |
| Claude Code | DevContainer feature | Official Anthropic support |

---

## Resolved Questions

These questions from the original research have been answered:

| Question | Resolution |
|----------|------------|
| GPU support? | Not needed for MVP; keep provider interface flexible |
| Persistent storage? | R2 with per-workspace encryption |
| Multi-repo workspaces? | Deferred; keep in mind for future |
| Claude auth persistence? | `CLAUDE_CONFIG_DIR=/workspaces/.claude` + R2 backup |
| Multi-tenancy? | Design interfaces now, implement later |
| Happy Coder dependency? | Eliminated via CloudCLI web UI |

---

## Implementation Phases

### Phase 1: MVP (Get It Working)
- Wildcard DNS via Cloudflare API
- Caddy with basic auth
- CloudCLI on port 3001
- No persistence (ephemeral workspaces)
- Single bearer token auth

### Phase 2: Port Discovery & Auth Control
- Port-watcher script
- Dynamic Caddy routes
- Subdomain per discovered port
- Auth toggle from control plane

### Phase 3: Persistence
- Cloudflare R2 integration
- Workspace encryption/decryption
- Auto-backup on idle/shutdown
- Key management in Workers KV

### Phase 4: Enhanced Security & Multi-Tenancy
- Cloudflare Tunnel option
- Cloudflare Access integration
- Per-tenant credentials
- User-registered runners

---

## What Needs to Be Built (MVP)

1. **Cloudflare Worker API** (`src/`)
   - POST /vms - Create VM + DNS
   - GET /vms - List VMs
   - DELETE /vms/:id - Delete VM + DNS
   - POST /vms/:id/cleanup - DNS cleanup callback

2. **Cloud-init Script**
   - Docker + devcontainer CLI installation
   - Caddy reverse proxy setup
   - CloudCLI installation
   - Idle monitor cron

3. **Cloudflare Pages UI**
   - Dashboard (list VMs)
   - Create VM form
   - VM detail with URLs

4. **VM-side Scripts**
   - `/usr/local/bin/idle-check.sh`
   - Caddy configuration

---

## Future Considerations

- **User-registered runners**: Cloudflare Tunnels enable machines behind NAT to register with the platform. This is the preferred future direction over direct IP/DNS.
- **Multi-agent support**: Aider, OpenHands as alternatives to Claude Code.
- **Token usage tracking**: Display costs in control plane UI.
- **Custom MCP server configuration**: UI for managing MCP servers.
