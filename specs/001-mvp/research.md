# Technical Research: Cloud AI Coding Workspaces MVP

**Feature**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Phase**: 0 - Technical Research
**Date**: 2026-01-24

## Purpose

This document consolidates technical research for the MVP implementation. It resolves NEEDS CLARIFICATION items and documents technology choices with rationale.

---

## Technology Stack Decisions

### API Framework: Hono

**Choice**: [Hono](https://hono.dev/) - Ultrafast web framework for Cloudflare Workers

**Rationale**:
- Purpose-built for edge runtimes (Workers, Bun, Deno)
- Express-like API, minimal learning curve
- Built-in middleware (auth, CORS, validation)
- TypeScript-first, excellent DX
- ~14KB bundle size

**Alternatives Considered**:
| Framework | Why Rejected |
|-----------|--------------|
| itty-router | Less middleware, smaller community |
| Express | Not optimized for Workers |
| Fastify | Node.js specific, not edge-native |

**Reference**: [Hono Docs](https://hono.dev/docs)

---

### Monorepo Tooling: pnpm + Turborepo

**Choice**: pnpm workspaces with Turborepo for build orchestration

**Rationale**:
- pnpm: Disk-efficient, strict dependency resolution, fast installs
- Turborepo: Caching, parallel execution, minimal config
- Used by Vercel, Shopify - battle-tested at scale

**Workspace Structure**:
```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

**Turborepo Config**:
```json
{
  "tasks": {
    "build": { "dependsOn": ["^build"], "outputs": ["dist/**"] },
    "test": { "dependsOn": ["build"] },
    "dev": { "cache": false, "persistent": true }
  }
}
```

**Reference**: [Turborepo Docs](https://turbo.build/repo/docs)

---

### Testing: Vitest + Miniflare

**Choice**: Vitest for unit tests, Miniflare for Worker integration tests

**Rationale**:
- Vitest: Fast, ESM-native, Jest-compatible API
- Miniflare: Local Cloudflare Workers simulator, supports KV/R2/D1

**Test Structure**:
```
apps/api/tests/
├── unit/           # Pure logic tests (Vitest)
│   ├── services/
│   └── lib/
└── integration/    # Worker endpoint tests (Miniflare)
    └── routes/
```

**Coverage Targets** (per Constitution Principle II):
- Critical paths (VM provisioning, DNS, idle detection): >90%
- Overall: >80%

**Reference**: [Vitest Cloudflare Guide](https://vitest.dev/guide/common-errors.html#cloudflare-workers)

---

### UI Framework: React (Vite)

**Choice**: React with Vite for Cloudflare Pages

**Rationale**:
- Vite: Fast dev server, optimized builds, native ESM
- React: Large ecosystem, good TypeScript support
- Cloudflare Pages: Free hosting, automatic deploys from Git

**Alternatives Considered**:
| Framework | Why Rejected |
|-----------|--------------|
| Svelte | Smaller ecosystem for component libraries |
| Preact | Less TypeScript tooling support |
| Vanilla JS | MVP needs state management, forms |

**UI Components**: Use [shadcn/ui](https://ui.shadcn.com/) for consistent design system.

---

### Cloud Provider: Hetzner Cloud

**Choice**: Hetzner CX22 (2 vCPU, 4GB RAM, 40GB SSD) - €5.39/month

**Rationale**:
- Best price/performance for devcontainers + Claude Code
- Reliable API, good documentation
- European data centers (GDPR-friendly)
- Self-terminating VM support via metadata endpoint

**API Details**:
```typescript
// Server metadata endpoint (available from within VM)
const SERVER_ID = await fetch('http://169.254.169.254/hetzner/v1/metadata/instance-id').then(r => r.text());

// Self-delete endpoint
await fetch(`https://api.hetzner.cloud/v1/servers/${SERVER_ID}`, {
  method: 'DELETE',
  headers: { 'Authorization': `Bearer ${HETZNER_TOKEN}` }
});
```

**VM Size Options**:
| Size | Type | vCPU | RAM | Storage | Price |
|------|------|------|-----|---------|-------|
| small | cx11 | 1 | 2GB | 20GB | €3.49/mo |
| medium | cx22 | 2 | 4GB | 40GB | €5.39/mo |
| large | cx32 | 4 | 8GB | 80GB | €10.49/mo |

**Reference**: [Hetzner Cloud API](https://docs.hetzner.cloud/)

---

### DNS: Cloudflare DNS API

**Choice**: Cloudflare DNS with wildcard A records, proxied (orange cloud)

**Architecture**:
```
*.{vm-id}.vm.example.com → VM IP (proxied through Cloudflare)
```

**Benefits**:
- DDoS protection (Cloudflare proxy)
- Fast propagation (~1 minute)
- Single API for DNS + Workers + Pages
- Free tier sufficient for MVP

**API Example**:
```typescript
// Create wildcard record
await fetch(`https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${CF_API_TOKEN}` },
  body: JSON.stringify({
    type: 'A',
    name: `*.${vmId}.vm`,
    content: vmIp,
    proxied: true,
    ttl: 1  // Auto when proxied
  })
});
```

**Reference**: [Cloudflare DNS API](https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-create-dns-record)

---

### Reverse Proxy: Caddy

**Choice**: Caddy for VM-side reverse proxy with automatic TLS

**Rationale**:
- Automatic HTTPS with Cloudflare DNS challenge
- Simple Caddyfile syntax
- Built-in basic auth
- JSON API for dynamic configuration
- Low memory (~20MB vs Traefik's ~50MB)

**Configuration**:
```caddyfile
# /etc/caddy/Caddyfile
{
  email admin@{$BASE_DOMAIN}
  acme_dns cloudflare {env.CF_API_TOKEN}
}

*.{$VM_ID}.vm.{$BASE_DOMAIN} {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }

  @ui host ui.{$VM_ID}.vm.{$BASE_DOMAIN}
  handle @ui {
    basicauth {
      {$AUTH_USER} {$AUTH_PASS_HASH}
    }
    reverse_proxy localhost:3001 {
      header_up Host "localhost:3001"
    }
  }
}
```

**Reference**: [Caddy Docs](https://caddyserver.com/docs/)

---

### Web UI for Claude Code: CloudCLI

**Choice**: [CloudCLI (siteboon/claudecodeui)](https://github.com/siteboon/claudecodeui)

**Rationale**:
- Integrated file explorer with syntax highlighting
- Git explorer (stage, commit, branch)
- Shell terminal built-in
- Session management
- PM2 support for production

**Installation**:
```bash
npm install -g @siteboon/claude-code-ui
claude-code-ui --port 3001
```

**Alternatives Considered**:
| Tool | Why Not Chosen |
|------|----------------|
| CUI (wbopan/cui) | Less mature, fewer features |
| ttyd | Terminal only, no file/git integration |
| OpenHands | Full agent, heavier than needed |

---

### DevContainer: Anthropic Official Feature

**Choice**: `ghcr.io/anthropics/devcontainer-features/claude-code:1.0`

**Default devcontainer.json** (when repo has none):
```json
{
  "name": "Claude Code Workspace",
  "image": "mcr.microsoft.com/devcontainers/base:ubuntu-22.04",
  "features": {
    "ghcr.io/devcontainers/features/git:1": {},
    "ghcr.io/devcontainers/features/github-cli:1": {},
    "ghcr.io/devcontainers/features/node:1": { "version": "22" },
    "ghcr.io/anthropics/devcontainer-features/claude-code:1.0": {}
  },
  "mounts": [
    "source=claude-config-${localWorkspaceFolderBasename},target=/home/vscode/.claude,type=volume"
  ],
  "containerEnv": {
    "CLAUDE_CONFIG_DIR": "/home/vscode/.claude"
  },
  "postCreateCommand": "claude --version",
  "remoteUser": "vscode"
}
```

**Reference**: [Anthropic DevContainer Features](https://github.com/anthropics/devcontainer-features)

---

## Cloud-Init Architecture

### Overview

Cloud-init configures VMs on first boot. The script must:
1. Install Docker and devcontainer CLI
2. Configure Caddy reverse proxy
3. Clone repository and start devcontainer
4. Install and configure CloudCLI
5. Setup idle monitoring
6. Inject secrets securely

### Cloud-Init Script Structure

```yaml
#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose
  - caddy
  - jq

write_files:
  - path: /etc/caddy/Caddyfile
    content: |
      # Caddy config injected here
  - path: /usr/local/bin/idle-check.sh
    permissions: '0755'
    content: |
      #!/bin/bash
      # Idle detection script

runcmd:
  # Enable Docker
  - systemctl enable docker
  - systemctl start docker

  # Install devcontainer CLI
  - npm install -g @devcontainers/cli

  # Clone repository
  - git clone ${REPO_URL} /workspace

  # Detect or create devcontainer.json
  - /usr/local/bin/setup-devcontainer.sh

  # Start devcontainer
  - devcontainer up --workspace-folder /workspace

  # Install CloudCLI
  - npm install -g @siteboon/claude-code-ui

  # Setup cron for idle detection
  - echo "*/5 * * * * root /usr/local/bin/idle-check.sh" > /etc/cron.d/idle-check
```

### Idle Detection Algorithm

```bash
#!/bin/bash
# /usr/local/bin/idle-check.sh
IDLE_FILE="/var/run/idle-check.state"
IDLE_THRESHOLD=30  # minutes
CHECK_INTERVAL=5   # minutes (cron frequency)

is_active() {
  # 1. Recent file changes in workspace
  [ -n "$(find /workspace -type f -mmin -$CHECK_INTERVAL 2>/dev/null | head -1)" ] && return 0

  # 2. Active Claude/Node processes
  pgrep -f "claude|@anthropic-ai|claude-code-ui" >/dev/null && return 0

  # 3. Active web connections (CloudCLI)
  [ "$(ss -tnp 2>/dev/null | grep -c ':3001.*ESTAB')" -gt 0 ] && return 0

  # 4. SSH sessions
  [ "$(who | wc -l)" -gt 0 ] && return 0

  # 5. Recent Claude session activity
  [ -n "$(find ~/.claude/sessions -type f -mmin -$CHECK_INTERVAL 2>/dev/null | head -1)" ] && return 0

  return 1
}

if is_active; then
  # Reset idle counter
  echo "0" > "$IDLE_FILE"
  echo "$(date): Active" >> /var/log/idle-check.log
else
  # Increment idle counter
  IDLE_COUNT=$(cat "$IDLE_FILE" 2>/dev/null || echo "0")
  IDLE_COUNT=$((IDLE_COUNT + CHECK_INTERVAL))
  echo "$IDLE_COUNT" > "$IDLE_FILE"

  echo "$(date): Idle for $IDLE_COUNT minutes" >> /var/log/idle-check.log

  if [ "$IDLE_COUNT" -ge "$IDLE_THRESHOLD" ]; then
    echo "$(date): Threshold reached, initiating shutdown" >> /var/log/idle-check.log

    # Notify control plane for DNS cleanup
    curl -sX POST "${API_URL}/vms/${VM_ID}/cleanup" \
      -H "Authorization: Bearer ${API_TOKEN}" \
      -H "Content-Type: application/json" \
      -d '{"reason": "idle_timeout"}'

    # Self-destruct
    SERVER_ID=$(curl -s http://169.254.169.254/hetzner/v1/metadata/instance-id)
    curl -X DELETE "https://api.hetzner.cloud/v1/servers/$SERVER_ID" \
      -H "Authorization: Bearer ${HETZNER_TOKEN}"
  fi
fi
```

---

## API Authentication

### Bearer Token Authentication (MVP)

Single bearer token from environment variable. Simple but sufficient for single-user MVP.

```typescript
// apps/api/src/lib/auth.ts
import { Context, Next } from 'hono';

export const bearerAuth = async (c: Context, next: Next) => {
  const authHeader = c.req.header('Authorization');
  const token = authHeader?.replace('Bearer ', '');

  if (!token || token !== c.env.API_TOKEN) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  await next();
};
```

### Future: JWT Authentication

For multi-tenancy, migrate to JWT with tenant claims:

```typescript
interface TokenPayload {
  sub: string;      // User ID
  tenant: string;   // Tenant ID
  iat: number;
  exp: number;
}
```

---

## Security Considerations

### Secrets Injection

Secrets are passed via cloud-init user_data (base64 encoded):

```typescript
const cloudInit = `
#cloud-config
write_files:
  - path: /etc/workspace/secrets
    permissions: '0600'
    content: |
      ANTHROPIC_API_KEY=${encryptedApiKey}
      HETZNER_TOKEN=${scopedHetznerToken}
      API_TOKEN=${apiToken}
`;

// User data is automatically base64 encoded by Hetzner
```

### Minimal VM Permissions

The Hetzner token on VMs should only allow:
- `DELETE /servers/{self}` - Self-termination only

Create a scoped API token with minimal permissions.

### Network Security

- Caddy handles TLS termination
- Cloudflare proxy hides VM IP
- Basic auth on all exposed ports
- VM firewall: allow only 80, 443 (via Cloudflare)

---

## Resolved Questions

| Question | Resolution |
|----------|------------|
| API framework? | Hono (edge-native, lightweight) |
| Monorepo tooling? | pnpm + Turborepo |
| Testing framework? | Vitest + Miniflare |
| UI framework? | React + Vite |
| Cloud provider? | Hetzner CX22 |
| DNS management? | Cloudflare DNS API |
| Reverse proxy? | Caddy |
| Claude Code UI? | CloudCLI |
| DevContainer? | Anthropic official feature |

---

## References

### Frameworks & Tools
- [Hono Documentation](https://hono.dev/docs)
- [Turborepo Documentation](https://turbo.build/repo/docs)
- [Vitest Documentation](https://vitest.dev/)
- [Caddy Documentation](https://caddyserver.com/docs/)

### Cloud Providers
- [Hetzner Cloud API](https://docs.hetzner.cloud/)
- [Cloudflare DNS API](https://developers.cloudflare.com/api/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)

### Claude Code
- [Claude Code DevContainer Feature](https://github.com/anthropics/devcontainer-features)
- [CloudCLI](https://github.com/siteboon/claudecodeui)
- [Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

### Project Research
- [Architecture Notes](../../research/architecture-notes.md)
- [AI Agent Optimizations](../../research/ai-agent-optimizations.md)
- [DNS, Security & Persistence](../../research/dns-security-persistence-plan.md)

---

## 2026-01-25 Update: Spec Revisions Research

The following sections document research for spec revisions addressing:
1. Claude Max authentication (no API key)
2. GitHub App integration for private repositories
3. Docker provider for local E2E testing

---

## GitHub App Integration

### Choice: GitHub App (not OAuth App)

**Rationale**:
- Fine-grained repository permissions (contents: read and write for clone + push)
- Short-lived installation access tokens (1 hour expiry)
- User chooses which repositories to grant access
- No long-lived tokens stored
- Can be installed on organizations
- Write access enables committing and pushing changes from workspaces

**OAuth App Rejected Because**:
- All-or-nothing repository access
- Requires user tokens with broader scope
- Token management complexity

### Authentication Flow

```
┌─────────────────────┐
│  1. User clicks     │
│  "Connect GitHub"   │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  2. Redirect to     │
│  GitHub App install │
│  page               │
└─────────┬───────────┘
          │ User selects repos
          ▼
┌─────────────────────┐
│  3. GitHub callback │
│  with installation  │
│  ID                 │
└─────────┬───────────┘
          │
          ▼
┌─────────────────────┐
│  4. Store install   │
│  ID in KV/D1        │
└─────────────────────┘
```

### Token Generation (at workspace creation)

```typescript
// 1. Generate JWT from App credentials
const jwt = await generateAppJWT(APP_ID, PRIVATE_KEY);

// 2. Request installation access token
const response = await fetch(
  `https://api.github.com/app/installations/${installationId}/access_tokens`,
  {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
      'Accept': 'application/vnd.github+json',
    },
    body: JSON.stringify({
      repositories: [repoName],  // Scope to single repo
      permissions: { contents: 'write' }  // 'write' includes read access
    })
  }
);

// 3. Token valid for 1 hour
const { token } = await response.json();
```

### Cloudflare Worker Implementation

Based on [gr2m/cloudflare-worker-github-app-example](https://github.com/gr2m/cloudflare-worker-github-app-example):

**Requirements**:
- Store `GITHUB_APP_ID` as worker secret
- Store `GITHUB_PRIVATE_KEY` as worker secret (PKCS#8 format)
- WebCrypto API for JWT signing

**Key Conversion** (PKCS#1 to PKCS#8):
```bash
openssl pkcs8 -topk8 -inform PEM -outform PEM \
  -nocrypt -in private-key.pem -out private-key-pkcs8.pem
```

### GitHub App Configuration

**Required Settings**:
- Name: "Cloud AI Workspaces"
- Callback URL: `https://api.{domain}/github/callback`
- Setup URL: `https://api.{domain}/github/setup` (optional)
- Webhook URL: Not required for MVP
- Permissions:
  - Repository: Contents (read and write) - enables clone and push
- Where can this GitHub App be installed?: "Any account"

**Reference**: [GitHub Apps Documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)

---

## Claude Max Authentication

### Choice: Interactive `claude login` via CloudCLI Terminal

**Rationale**:
- Claude Max subscribers use OAuth flow, not API keys
- CloudCLI has integrated terminal for running commands
- No secrets to manage or store
- User controls their own authentication

**How It Works**:
1. User creates workspace (no API key needed)
2. User opens CloudCLI web interface
3. User runs `claude login` in terminal
4. Browser opens for OAuth authentication
5. Claude Code authenticated for session

**Critical Requirement**:
- VM MUST NOT set `ANTHROPIC_API_KEY` environment variable
- If set, it overrides subscription auth and breaks Max flow

### CloudCLI Terminal Verification

CloudCLI ([siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)) provides:
- Integrated shell terminal
- File explorer
- Git explorer
- Session management

The terminal is fully interactive and supports `claude login` OAuth flow.

**Reference**: [Claude Code Authentication](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan)

---

## Local Testing Infrastructure (Docker Provider)

### Choice: Docker-in-Docker with devcontainer CLI

**Rationale**:
- Simulates VM provisioning without cloud credentials
- Uses same cloud-init scripts (adapted for Docker)
- Enables E2E testing in CI/CD
- Fast iteration during development

**Rejected Alternatives**:
| Alternative | Why Rejected |
|-------------|--------------|
| Testcontainers Cloud | External service, adds dependency |
| Mock provider only | Doesn't test real container lifecycle |
| Local VMs (VirtualBox) | Slow, heavy, not CI-friendly |

### Docker Provider Architecture

```
┌─────────────────────────────────────────────┐
│  Docker Host (local machine or CI runner)   │
│                                             │
│  ┌─────────────────────────────────────┐   │
│  │  "VM" Container (--privileged)       │   │
│  │  - Docker-in-Docker daemon           │   │
│  │  - devcontainer CLI                  │   │
│  │  ┌────────────────────────────────┐  │   │
│  │  │  Devcontainer                  │  │   │
│  │  │  - Claude Code                 │  │   │
│  │  │  - Project files               │  │   │
│  │  └────────────────────────────────┘  │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

### Provider Interface Implementation

```typescript
// packages/providers/src/docker.ts

export class DockerProvider implements Provider {
  readonly name = 'docker';

  async createVM(config: VMConfig): Promise<VMInstance> {
    // 1. Create container with privileged mode
    const containerId = await this.docker.createContainer({
      Image: 'docker:dind',
      HostConfig: {
        Privileged: true,
        PortBindings: {
          '3001/tcp': [{ HostPort: config.port }],
          '443/tcp': [{ HostPort: config.httpsPort }],
        },
      },
      Labels: {
        'managed-by': 'cloud-ai-workspaces',
        'workspace-id': config.workspaceId,
      },
    });

    // 2. Start container
    await this.docker.startContainer(containerId);

    // 3. Run cloud-init equivalent script
    await this.execSetupScript(containerId, config);

    return {
      id: containerId,
      name: config.name,
      ip: 'localhost',
      status: 'running',
      serverType: 'docker',
      createdAt: new Date().toISOString(),
      labels: config.labels,
    };
  }

  async deleteVM(id: string): Promise<void> {
    await this.docker.stopContainer(id);
    await this.docker.removeContainer(id);
  }
}
```

### E2E Test Flow

```typescript
// apps/api/tests/e2e/workspace-lifecycle.test.ts

describe('Workspace Lifecycle (Docker)', () => {
  const provider = new DockerProvider();

  it('creates workspace and runs devcontainer', async () => {
    const workspace = await api.createWorkspace({
      repoUrl: 'https://github.com/user/test-repo',
      provider: 'docker',
    });

    expect(workspace.status).toBe('creating');

    // Wait for container to be ready
    await waitFor(() => api.getWorkspace(workspace.id).status === 'running');

    // Verify CloudCLI is accessible
    const response = await fetch(`http://localhost:${workspace.port}`);
    expect(response.status).toBe(200);
  });
});
```

### CI/CD Configuration

```yaml
# .github/workflows/e2e.yml
name: E2E Tests

on: [push, pull_request]

jobs:
  e2e:
    runs-on: ubuntu-latest
    services:
      dind:
        image: docker:dind
        options: --privileged
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm test:e2e
        env:
          PROVIDER: docker
```

**Reference**: [Docker-in-Docker Patterns](https://java.testcontainers.org/supported_docker_environment/continuous_integration/dind_patterns/)

---

## Updated Resolved Questions

| Question | Resolution |
|----------|------------|
| Claude authentication? | Interactive `claude login` via CloudCLI terminal |
| Private repos? | GitHub App with installation access tokens |
| API key required? | No - Claude Max uses OAuth |
| Local E2E testing? | Docker provider with DinD |
| CI/CD testing? | GitHub Actions with DinD service |
