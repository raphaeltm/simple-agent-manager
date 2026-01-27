# Cloud AI Coding Workspaces - Architecture Research

> **Related docs:** [AI Agent Optimizations](./ai-agent-optimizations.md) | [DNS & Security](./dns-security-persistence-plan.md) | [Multi-tenancy](./multi-tenancy-interfaces.md) | [Index](./README.md)

## Overview

A lightweight, serverless platform to spin up **AI coding agent environments** on-demand. Think "GitHub Codespaces, but optimized for Claude Code and AI-assisted development."

The system should have zero ongoing cost when not in use, with VMs that self-terminate after idle periods.

**Key Insight:** This is NOT a generic devcontainer orchestrator. It's purpose-built for AI coding workflows with first-class support for:
- Claude Code (and future agents like Aider, OpenHands)
- API key management
- Session persistence across VM restarts
- Agent-aware idle detection

**Update (Jan 2025):** Research shows we can eliminate the Happy Coder dependency entirely by using existing Claude Code web UIs that run directly in the devcontainer.

**See also:** [AI Agent UX Optimizations](./ai-agent-optimizations.md) for detailed implementation.

## Goals

1. **Serverless UI** with minimal auth (single user, env var token)
2. **Spin up AI coding workspaces** from any git repo (detect `.devcontainer/devcontainer.json` or use AI-optimized default)
3. **First-class API key management** - secure input, storage, and injection of ANTHROPIC_API_KEY
4. **Claude Code pre-installed** with persistent `~/.claude` config (sessions, MCP servers, settings)
5. **Auto-shutdown** after 30min of inactivity (agent-aware: file changes, Claude processes, web sessions)
6. **Multi-provider support** (start with cheapest, allow adding others)
7. **Session continuity** - `claude --continue` works across VM restarts

---

## Provider Comparison (January 2025)

| Provider | Tier | vCPU | RAM | Storage | Price | Notes |
|----------|------|------|-----|---------|-------|-------|
| Scaleway STARDUST1-S | Entry | 1 | 1GB | 10GB | €0.99/mo | Too small for devcontainers |
| Scaleway DEV1-S | Dev | 2 | 2GB | 20GB | ~€4/mo | Workable minimum |
| **Hetzner CX22** | Dev | 2 | 4GB | 40GB | €5.39/mo | **Best value** |
| Hetzner CX11 | Entry | 1 | 2GB | 20GB | €3.49/mo | Tight for Docker |
| DigitalOcean Basic | Entry | 1 | 1GB | 25GB | $6/mo | More expensive |
| OVH VLE-2 | Entry | 2 | 2GB | 40GB | $5.50/mo | No traffic charges |

**Recommendation:** Start with Hetzner CX22 (4GB RAM comfortable for devcontainers + Claude Code)

### API References
- Hetzner: https://docs.hetzner.cloud/
- Scaleway: https://www.scaleway.com/en/developers/api/instances/
- OVH: https://api.ovh.com/

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Pages (Static UI)                           │
│  • Form: git repo URL, provider, size                   │
│  • List running VMs                                     │
│  • "Open Terminal" button → vm-ip:7681                  │
│  • "Stop" button                                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Worker (API)                                │
│  • POST /vms - create VM with cloud-init                │
│  • GET /vms - query provider API directly (no DB!)      │
│  • DELETE /vms/:id - terminate VM                       │
│  • Auth: Bearer token from env var                      │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Cloud Provider API (Hetzner / Scaleway / OVH)          │
│  • Create server with cloud-init user_data              │
│  • List servers (filtered by tag/label)                 │
│  • Delete server                                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Self-Managing VM                                       │
│  1. Docker + @devcontainers/cli                         │
│  2. Clone repo, detect/create devcontainer.json         │
│  3. Start devcontainer                                  │
│  4. ttyd on :7681 (web terminal with basic auth)        │
│  5. Idle monitor cron → self-destruct when idle         │
└─────────────────────────────────────────────────────────┘
```

### Key Insight: Self-Terminating VMs

VMs can delete themselves using the cloud provider API, eliminating the need for an external control plane:

```bash
# Hetzner self-destruct
SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
curl -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \
  -H "Authorization: Bearer $HETZNER_TOKEN"

# Scaleway self-destruct
SERVER_ID=$(curl -s http://169.254.42.42/conf?format=json | jq -r '.id')
curl -X DELETE "https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/$SERVER_ID" \
  -H "X-Auth-Token: $SCALEWAY_TOKEN"
```

---

## Web Terminal: ttyd

[ttyd](https://github.com/tsl0922/ttyd) is a lightweight single-binary tool to share terminal over the web.

**Features needed:**
- Basic auth: `-c user:password`
- Runs inside VM, exposes port 7681
- Points to devcontainer: `ttyd docker exec -it <container> bash`

**Installation in cloud-init:**
```bash
apt-get install -y ttyd

# Start ttyd pointing to devcontainer
CONTAINER_ID=$(docker ps -q --filter "label=devcontainer.local_folder=/workspace")
ttyd -p 7681 -c "user:${TERMINAL_PASSWORD}" docker exec -it $CONTAINER_ID bash &
```

**Security:**
- Basic auth with per-VM generated password
- Could add Cloudflare Tunnel for extra security (free)
- Single user system, acceptable risk

---

## Devcontainer Detection Logic

```bash
#!/bin/bash
REPO_URL="${REPO_URL}"

git clone "$REPO_URL" /workspace
cd /workspace

# Check for existing devcontainer config
if [ -f ".devcontainer/devcontainer.json" ] || [ -f ".devcontainer.json" ]; then
  echo "Using existing devcontainer.json"
else
  # Create default devcontainer
  mkdir -p .devcontainer
  cat > .devcontainer/devcontainer.json << 'EOF'
{
  "name": "Default Dev Container",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu",
  "features": {
    "ghcr.io/devcontainers/features/node:1": {},
    "ghcr.io/devcontainers/features/docker-in-docker:2": {}
  },
  "postCreateCommand": "npm install -g @anthropic-ai/claude-code happy-coder"
}
EOF
fi

# Build and start devcontainer
devcontainer up --workspace-folder /workspace
```

---

## Idle Detection

Check multiple signals to avoid premature shutdown:

```bash
#!/bin/bash
# /usr/local/bin/idle-check.sh
IDLE_MINUTES=30
WORKSPACE="/workspace"

is_idle() {
  # 1. Recent file changes in workspace
  recent_files=$(find "$WORKSPACE" -type f -mmin -$IDLE_MINUTES 2>/dev/null | head -1)

  # 2. Active Claude/Node/Happy processes
  active_procs=$(pgrep -f "claude|node|happy" | head -1)

  # 3. SSH sessions
  ssh_sessions=$(who | wc -l)

  # 4. Active ttyd websocket connections (web terminal users)
  ttyd_connections=$(ss -tnp 2>/dev/null | grep -c ":7681.*ESTAB" || echo 0)

  # Only idle if ALL conditions are true
  [ -z "$recent_files" ] && \
  [ -z "$active_procs" ] && \
  [ "$ssh_sessions" -eq 0 ] && \
  [ "$ttyd_connections" -eq 0 ]
}

if is_idle; then
  echo "$(date): VM idle, initiating self-destruct" >> /var/log/idle-check.log
  ${SELF_DELETE_COMMAND}  # Injected by cloud-init, provider-specific
fi
```

**Cron setup:**
```bash
echo "*/5 * * * * root /usr/local/bin/idle-check.sh" > /etc/cron.d/idle-check
```

---

## Provider Abstraction

```typescript
// src/providers/types.ts
export interface VMConfig {
  name: string;
  repoUrl: string;
  sshPublicKey: string;
  terminalPassword: string;
  size: 'small' | 'medium' | 'large';
}

export interface VM {
  id: string;
  name: string;
  ip: string;
  status: 'creating' | 'running' | 'stopping';
  provider: string;
  createdAt: string;
}

export interface Provider {
  name: string;
  createVM(config: VMConfig): Promise<VM>;
  deleteVM(id: string): Promise<void>;
  listVMs(): Promise<VM[]>;
  getSizeConfig(size: VMConfig['size']): { type: string; price: string };
  generateCloudInit(config: VMConfig): string;
}
```

```typescript
// src/providers/hetzner.ts
export class HetznerProvider implements Provider {
  name = 'hetzner';

  getSizeConfig(size: VMConfig['size']) {
    const sizes = {
      small: { type: 'cx11', price: '€3.49/mo' },
      medium: { type: 'cx22', price: '€5.39/mo' },
      large: { type: 'cx32', price: '€10.49/mo' },
    };
    return sizes[size];
  }

  async createVM(config: VMConfig): Promise<VM> {
    const response = await fetch('https://api.hetzner.cloud/v1/servers', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: config.name,
        server_type: this.getSizeConfig(config.size).type,
        image: 'ubuntu-24.04',
        ssh_keys: [this.sshKeyId],
        user_data: this.generateCloudInit(config),
        labels: { 'managed-by': 'devcontainer-manager' },
      }),
    });
    // ... handle response
  }
}
```

---

## Cost Analysis

| Scenario | Cost |
|----------|------|
| **Idle (no VMs running)** | **€0/mo** |
| Hetzner CX22 per hour | €0.0076 |
| 4 hours/day × 20 days | €0.61/mo |
| 8 hours/day × 20 days | €1.22/mo |
| Always on (worst case) | €5.39/mo |

**Cloudflare (free tier):**
- Pages: Unlimited sites
- Workers: 100K requests/day
- KV: 100K reads/day (not needed, stateless)

---

## User Flow

1. **Open UI** at `https://devcontainer-manager.pages.dev`
2. **Enter git repo URL**: `https://github.com/user/project`
3. **Select provider** (default: Hetzner) and **size** (default: medium/CX22)
4. **Click "Create"** → Worker generates password, calls Hetzner API
5. **Wait ~60-90 seconds** for VM boot + devcontainer build
6. **Click "Open Terminal"** → browser opens `http://VM_IP:7681`
7. **Login** with generated password shown in UI
8. **Run setup**: `claude auth login` (one-time)
9. **Connect via Happy Coder** for actual development
10. **After 30min idle** → VM self-destructs automatically

---

## Security Considerations

- **API Auth**: Single bearer token in Cloudflare Worker env
- **Terminal Auth**: Per-VM generated password (shown once in UI)
- **Cloud API Token**: Passed to VM via cloud-init user_data (necessary for self-destruct)
- **SSH**: User's public key added to VM
- **Network**: ttyd on public IP with basic auth (acceptable for single-user)

**Optional enhancements:**
- Cloudflare Tunnel for ttyd (free, hides VM IP)
- Firewall rules to restrict ttyd to user's IP

---

## Web UI for Claude Code (Eliminating Happy Coder)

Research uncovered several open-source web UIs that can replace both ttyd AND Happy Coder, providing a full browser-based Claude Code experience.

### Option 1: CUI (Recommended)

**Repository:** [wbopan/cui](https://github.com/wbopan/cui)

A modern web UI built on the Claude Code SDK.

**Features:**
- Push notifications when Claude needs input
- Parallel background agents
- Multi-model support (not just Claude)
- Dictation support
- Responsive design (works on mobile)

**Installation:**
```bash
npx cui-server
# Or globally: npm install -g cui-server
```

**Port:** 3001 (configurable via `~/.cui/config.json` or `--port` flag)

**Remote Access:** Set `server.host` to `0.0.0.0` in config. Use HTTPS via reverse proxy (Caddy recommended).

### Option 2: CloudCLI (Claude Code UI)

**Repository:** [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)

Feature-rich UI supporting Claude Code, Cursor CLI, and Codex.

**Features:**
- Interactive chat interface
- Integrated shell terminal
- File explorer with syntax highlighting
- Git explorer (stage, commit, branch)
- Session management
- PM2 support for production deployment

**Installation:**
```bash
npx @siteboon/claude-code-ui
# Or globally: npm install -g @siteboon/claude-code-ui
```

**Port:** 3001 (configurable via `--port` or `-p` flag)

**Remote Access:** Works as web server, can access from any device on network.

### Option 3: claude-code-web (vultuk)

**Repository:** [vultuk/claude-code-web](https://github.com/vultuk/claude-code-web)

Simple, secure web interface with built-in authentication.

**Features:**
- Multi-session support
- Token-based auth (auto-generated, v2.0+)
- HTTPS/SSL support
- Real-time streaming

### Option 4: OpenHands (Full Agent Alternative)

**Repository:** [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands)

A complete autonomous coding agent (formerly OpenDevin) - could replace Claude Code entirely.

**Features:**
- Full web UI at localhost:3000
- Docker sandbox for security
- Can write code, run commands, browse web
- MIT licensed
- 38K+ GitHub stars

**Installation:**
```bash
docker run -p 3000:3000 \
  -e WORKSPACE_BASE=/workspace \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/openhands/openhands:latest
```

**Trade-off:** More powerful but heavier than Claude Code wrappers.

### Comparison

| Tool | Type | Install | Port | Auth | Best For |
|------|------|---------|------|------|----------|
| **CUI** | Claude Code wrapper | `npx cui-server` | 3001 | Config | Modern UI, notifications |
| **CloudCLI** | Multi-agent wrapper | `npx @siteboon/claude-code-ui` | 3001 | None (add proxy) | File/Git integration |
| **claude-code-web** | Claude Code wrapper | npm install | 3001 | Token (built-in) | Simple, secure |
| **OpenHands** | Full agent | Docker | 3000 | Configurable | Maximum capability |

### Updated Architecture (No Happy Coder)

```
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Pages (Static UI)                           │
│  • Form: git repo URL, provider, size                   │
│  • List running VMs                                     │
│  • "Open IDE" button → vm-ip:3001                       │
│  • "Stop" button                                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Cloudflare Worker (API)                                │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Self-Managing VM                                       │
│  1. Docker + @devcontainers/cli                         │
│  2. Clone repo, detect/create devcontainer.json         │
│  3. Start devcontainer                                  │
│  4. CUI or CloudCLI on :3001 (web IDE for Claude Code)  │
│  5. Idle monitor cron → self-destruct when idle         │
└─────────────────────────────────────────────────────────┘
```

### Updated Cloud-Init (Using CUI)

```bash
#!/bin/bash
# ... Docker and devcontainer setup ...

# Install and start CUI (Claude Code Web UI)
npm install -g cui-server

# Configure for remote access
mkdir -p ~/.cui
cat > ~/.cui/config.json << EOF
{
  "server": {
    "host": "0.0.0.0",
    "port": 3001
  }
}
EOF

# Start CUI in background (pointing to workspace)
cd /workspace
nohup cui-server > /var/log/cui.log 2>&1 &
```

### Updated Idle Detection

```bash
# Check for CUI connections instead of ttyd
cui_connections=$(ss -tnp 2>/dev/null | grep -c ":3001.*ESTAB" || echo 0)
```

### Benefits of This Approach

1. **No Happy Coder dependency** - full browser-based experience
2. **Better UX** - purpose-built UI vs terminal emulation
3. **Push notifications** - know when Claude needs input
4. **File/Git integration** - no need to switch tools
5. **Same security model** - basic auth or token-based

---

## Resolved Questions

| Question | Resolution | Details |
|----------|------------|---------|
| **GPU support?** | Not needed for MVP | Keep provider interface flexible for Lambda Labs, Vast.ai later |
| **Persistent storage?** | Cloudflare R2 | Per-workspace encryption, backup on shutdown, restore on startup |
| **Multi-repo workspaces?** | Deferred | Keep in mind for future |
| **Claude auth persistence?** | `CLAUDE_CONFIG_DIR` + R2 | Set to `/workspaces/.claude`, backed up with workspace |

**See:** [DNS, Security & Persistence Plan](./dns-security-persistence-plan.md) for implementation details.

---

## Future Directions

### User-Registered Runners (Cloudflare Tunnels)

The MVP uses wildcard DNS with direct IP addresses. However, the preferred future direction is **Cloudflare Tunnels**, which enables:

- **User-registered runners**: Machines behind NAT can register with the platform
- **Hidden IP addresses**: VMs not directly exposed to internet
- **Zero Trust security**: Cloudflare Access integration
- **Simplified networking**: No firewall configuration needed

**See:** [DNS, Security & Persistence Plan](./dns-security-persistence-plan.md#dns-options-analysis) for comparison.

---

## References

### Cloud Providers
- [Hetzner Cloud API](https://docs.hetzner.cloud/)
- [Scaleway Instances API](https://www.scaleway.com/en/developers/api/instances/)
- [Affordable Cloud Comparison 2025](https://medium.com/@firat-gulec/affordable-cloud-in-2025-4082c00446e0)

### Dev Containers
- [devcontainers CLI](https://github.com/devcontainers/cli)
- [Cloud-init Documentation](https://cloudinit.readthedocs.io/)

### Claude Code Web UIs
- [CUI - Common Agent UI](https://github.com/wbopan/cui)
- [CloudCLI / Claude Code UI](https://github.com/siteboon/claudecodeui)
- [claude-code-web](https://github.com/vultuk/claude-code-web)
- [claude-code-webui](https://github.com/sugyan/claude-code-webui)

### Alternative Agents
- [OpenHands (formerly OpenDevin)](https://github.com/OpenHands/OpenHands)
- [Aider](https://github.com/paul-gauthier/aider)
- [Cline](https://github.com/clinebot/cline)

### Terminal Tools (Legacy Option)
- [ttyd - Web Terminal](https://github.com/tsl0922/ttyd)
- [Happy Coder](https://happy.engineering/)
