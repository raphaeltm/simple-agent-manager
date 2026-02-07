# DNS, Security & Persistence Planning

> **HISTORICAL DOCUMENT**: This is early research from January 2025. The R2 workspace persistence features described here are not yet implemented (planned for Phase 3 per ROADMAP.md). DNS and security sections informed the current implementation but specific details may differ. See [docs/architecture/](../docs/architecture/) for actual architecture.

> **Related docs:** [Architecture Notes](./architecture-notes.md) | [AI Agent Optimizations](./ai-agent-optimizations.md) | [Multi-tenancy](./multi-tenancy-interfaces.md) | [Index](./README.md)

## Resolved Questions from Previous Research

### 1. GPU Support
- **Decision:** Not needed for MVP
- **Action:** Keep provider interface flexible to add GPU providers (Lambda Labs, Vast.ai) later

### 2. Persistent Storage
- **Decision:** Use S3-compatible storage (Cloudflare R2) for workspace persistence
- **Mechanism:** Encrypt and upload /workspaces on shutdown, download and decrypt on startup
- **Encryption:** Per-workspace key stored in Workers KV, encrypted with master key from env

### 3. Multi-repo Workspaces
- **Decision:** Ignore for now, keep in mind for future

### 4. Claude Auth Persistence
- **Decision:** Set `CLAUDE_CONFIG_DIR=/workspaces/.claude` in devcontainer
- **Result:** Claude credentials persist with workspace backup

### 5. Multi-tenancy Support
- **Decision:** Design interfaces to support multi-tenancy from day one
- **MVP:** Single "default" tenant, credentials from env vars
- **Future:** Full multi-tenant with per-tenant credentials, DNS, storage
- **See:** [Multi-tenancy Interface Design](./multi-tenancy-interfaces.md)

---

## New Requirements

### UI Choice: CloudCLI
- **Rationale:** File explorer + terminal integration is valuable
- **Port:** 3001
- **Repo:** [siteboon/claudecodeui](https://github.com/siteboon/claudecodeui)

### DNS & Domain Management
- Need dynamic DNS for VM access
- Fast propagation required
- Consider Cloudflare's infrastructure (already using for Workers/Pages)

### Security
- Basic HTTP auth for all exposed ports
- Toggleable auth per-port from control plane
- Ports should appear as localhost to apps (Host header rewriting)

### Port Forwarding
- Automatic port discovery (watch for new listening ports)
- Expose via subdomains: `{port}.{vm-id}.vm.example.com`
- Reverse proxy with Host header rewriting

---

## DNS Options Analysis

### Option A: Wildcard DNS + Direct IP (Recommended for MVP)

```
*.{vm-id}.vm.example.com → VM IP (A record)
```

**Flow:**
1. User owns domain, points NS to Cloudflare
2. Worker creates wildcard A record when VM starts
3. Caddy on VM handles TLS (Let's Encrypt or Cloudflare)
4. Cloudflare proxies traffic (orange cloud) for DDoS protection

**Pros:**
- Simple to implement
- Fast (~1 min propagation with Cloudflare)
- No tunnel complexity

**Cons:**
- VM IP exposed (mitigated by Cloudflare proxy)
- Need firewall + auth on VM

### Option B: Cloudflare Tunnel

**Flow:**
1. VM runs `cloudflared` daemon
2. Creates tunnel with auto-assigned or configured hostname
3. Traffic routed through Cloudflare's network

**Pros:**
- No exposed IP
- Built-in Cloudflare security
- Can add Cloudflare Access for Zero Trust

**Cons:**
- User finds it "finicky"
- More moving parts
- Tunnel lifecycle management

### Option C: Hybrid Approach

- CloudCLI via Cloudflare Tunnel (secure, hidden IP)
- Dev ports via direct IP + basic auth

**Decision for MVP:** Start with **Option A** (simplest), upgrade path to Option B/C later.

---

## Persistence Architecture

### Storage: Cloudflare R2

**Why R2:**
- Native to Cloudflare ecosystem
- S3-compatible API
- No egress fees (critical for workspace downloads)
- Can access from Workers directly

**Alternatives considered:**
- Backblaze B2: Cheap but egress fees
- AWS S3: Standard but expensive egress
- MinIO: Self-hosted, defeats serverless goal

### Encryption Strategy

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Workers KV                                      │
│  Key: workspace:{workspace-id}:encryption-key               │
│  Value: AES-256 key (encrypted with master key from env)    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare R2                                              │
│  Bucket: workspaces                                         │
│  Object: {workspace-id}/workspace.tar.gz.enc                │
└─────────────────────────────────────────────────────────────┘
```

### Backup/Restore Flow

**On VM Shutdown (or periodic backup):**
```bash
#!/bin/bash
# 1. Tar workspace
tar -czf /tmp/workspace.tar.gz -C /workspaces .

# 2. Encrypt with workspace key (provided by Worker)
openssl enc -aes-256-cbc -salt -pbkdf2 \
  -in /tmp/workspace.tar.gz \
  -out /tmp/workspace.tar.gz.enc \
  -pass env:WORKSPACE_KEY

# 3. Upload to R2
aws s3 cp /tmp/workspace.tar.gz.enc \
  s3://workspaces/${WORKSPACE_ID}/workspace.tar.gz.enc \
  --endpoint-url ${R2_ENDPOINT}

# 4. Cleanup and self-destruct
rm /tmp/workspace.tar.gz /tmp/workspace.tar.gz.enc
${SELF_DELETE_COMMAND}
```

**On VM Startup:**
```bash
#!/bin/bash
# 1. Download from R2 (if exists)
aws s3 cp s3://workspaces/${WORKSPACE_ID}/workspace.tar.gz.enc \
  /tmp/workspace.tar.gz.enc \
  --endpoint-url ${R2_ENDPOINT} || true

# 2. If backup exists, decrypt and extract
if [ -f /tmp/workspace.tar.gz.enc ]; then
  openssl enc -aes-256-cbc -d -pbkdf2 \
    -in /tmp/workspace.tar.gz.enc \
    -out /tmp/workspace.tar.gz \
    -pass env:WORKSPACE_KEY

  tar -xzf /tmp/workspace.tar.gz -C /workspaces
  rm /tmp/workspace.tar.gz /tmp/workspace.tar.gz.enc
fi
```

### Key Rotation

1. Generate new key
2. Download and decrypt with old key
3. Re-encrypt with new key
4. Upload new encrypted backup
5. Update key in KV
6. Delete old key

---

## VM-Side Reverse Proxy

### Choice: Caddy

**Why Caddy over Traefik:**
- Simpler configuration (Caddyfile)
- Built-in automatic HTTPS
- Lower memory (~20MB vs ~50MB)
- JSON API for dynamic config
- Built-in basic auth

### Port Discovery Mechanism

Neither Caddy nor Traefik auto-discovers ports. Need custom script:

```bash
#!/bin/bash
# /usr/local/bin/port-watcher.sh
# Runs every 10 seconds via systemd timer

KNOWN_PORTS="22"  # System ports to ignore
AUTH_CONFIG="/etc/caddy/auth-config.json"
CADDY_API="http://localhost:2019"

# Get all listening TCP ports
LISTENING=$(ss -tlnp | awk 'NR>1 {print $4}' | grep -oE '[0-9]+$' | sort -u)

for PORT in $LISTENING; do
  # Skip known system ports
  [[ " $KNOWN_PORTS " =~ " $PORT " ]] && continue

  # Check if route already exists
  # If not, add route via Caddy API
  # ...
done
```

### URL Structure

**Subdomain approach (recommended):**
```
ui.{vm-id}.vm.example.com    → CloudCLI (port 3001)
3000.{vm-id}.vm.example.com  → port 3000
8080.{vm-id}.vm.example.com  → port 8080
```

**Why subdomains over subdirectories:**
- Cleaner URLs
- Apps work better (no path prefix issues)
- Wildcard cert handles all

### Caddy Configuration

```caddyfile
# /etc/caddy/Caddyfile
{
  email admin@example.com
  acme_dns cloudflare {env.CF_API_TOKEN}
}

*.{$VM_ID}.vm.example.com {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }

  # CloudCLI - always auth
  @ui host ui.{$VM_ID}.vm.example.com
  handle @ui {
    basicauth {
      {$AUTH_USER} {$AUTH_PASS_HASH}
    }
    reverse_proxy localhost:3001 {
      header_up Host "localhost:3001"
    }
  }

  # Port 3000 - configurable auth
  @port3000 host 3000.{$VM_ID}.vm.example.com
  handle @port3000 {
    # Auth applied based on config
    reverse_proxy localhost:3000 {
      header_up Host "localhost:3000"
    }
  }

  # Fallback
  handle {
    respond "Port not found" 404
  }
}
```

### Host Header Rewriting

**Why needed:**
- Many dev servers check Host header for security
- Apps generate URLs based on Host header
- Some reject requests from unexpected hosts

**Caddy handles this:**
```caddyfile
reverse_proxy localhost:3000 {
  header_up Host "localhost:3000"
  header_up X-Forwarded-Host {host}
  header_up X-Real-IP {remote_host}
}
```

### Auth Toggle Mechanism

```json
// /etc/caddy/auth-config.json
{
  "global_auth": true,
  "credentials": {
    "username": "user",
    "password_hash": "$2a$14$..."
  },
  "port_overrides": {
    "3000": { "auth": false, "note": "Public preview" },
    "3001": { "auth": true, "note": "CloudCLI always protected" }
  }
}
```

Control plane can update this via SSH or a simple HTTP endpoint on the VM.

---

## Implementation Phases

### Phase 1: MVP (Get it working)

**Scope:**
- Wildcard DNS via Cloudflare API
- Caddy with basic auth (single user/pass)
- Port 3001 (CloudCLI) only
- No persistence (ephemeral workspaces)
- Single bearer token for API auth

**Components:**
1. Cloudflare Worker API
2. Cloud-init script
3. Simple Pages UI
4. Idle monitor with DNS cleanup

### Phase 2: Port Discovery & Auth Control

**Scope:**
- Port-watcher script
- Dynamic Caddy routes via API
- Subdomain per discovered port
- Auth toggle from control plane
- Port visibility in UI

### Phase 3: Persistence

**Scope:**
- Cloudflare R2 integration
- Workspace encryption/decryption
- Auto-backup on idle/shutdown
- Auto-restore on startup
- Key management in Workers KV

### Phase 4: Enhanced Security

**Scope:**
- Cloudflare Tunnel option
- Cloudflare Access integration
- Per-workspace secrets
- Key rotation mechanism
- Audit logging

---

## Revised MVP Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Pages (Control Plane UI)                        │
│  • Create VM: repo URL, provider, size                      │
│  • List VMs with status and URLs                            │
│  • Delete VM                                                │
│  • Show: ui.{vm-id}.vm.example.com                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (API)                                    │
│  • POST /vms → create VM + wildcard DNS record              │
│  • GET /vms → list VMs from provider API                    │
│  • DELETE /vms/:id → delete VM + DNS record                 │
│  • POST /vms/:id/cleanup → DNS cleanup (called by VM)       │
│  Auth: Bearer token from env                                │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
┌─────────────────────┐    ┌─────────────────────┐
│  Cloudflare DNS     │    │  Cloud Provider     │
│                     │    │  (Hetzner API)      │
│  A record:          │    │                     │
│  *.{vm-id}.vm...    │    │  Create VM with     │
│  → VM IP (proxied)  │    │  cloud-init         │
└─────────────────────┘    └──────────┬──────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────┐
│  VM                                                         │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Caddy (ports 80/443)                                 │ │
│  │  • Wildcard TLS via Cloudflare DNS challenge          │ │
│  │  • Basic auth (credentials from cloud-init)           │ │
│  │  • Reverse proxy: ui.* → localhost:3001               │ │
│  │  • Host header rewriting → localhost                  │ │
│  └───────────────────────────────────────────────────────┘ │
│                          │                                  │
│                          ▼                                  │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Devcontainer                                         │ │
│  │  • CloudCLI on :3001                                  │ │
│  │  • CLAUDE_CONFIG_DIR=/workspaces/.claude              │ │
│  │  • User's project code                                │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │  Idle Monitor (cron every 5 min)                      │ │
│  │  • Check file activity, processes, connections        │ │
│  │  • If idle > 30min:                                   │ │
│  │    1. Call Worker cleanup endpoint                    │ │
│  │    2. Self-destruct via provider API                  │ │
│  └───────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## DNS Management Details

### Creating DNS Record (Worker)

```typescript
async function createVMDNSRecord(vmId: string, ip: string): Promise<void> {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        type: 'A',
        name: `*.${vmId}.vm`,  // Wildcard for port subdomains
        content: ip,
        proxied: true,  // Orange cloud = DDoS protection
        ttl: 1,  // Auto (when proxied)
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`DNS creation failed: ${await response.text()}`);
  }
}
```

### Deleting DNS Record (Worker)

```typescript
async function deleteVMDNSRecord(vmId: string): Promise<void> {
  // First, find the record ID
  const listResponse = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records?name=*.${vmId}.vm.${env.BASE_DOMAIN}`,
    {
      headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
    }
  );

  const { result } = await listResponse.json();

  for (const record of result) {
    await fetch(
      `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${record.id}`,
      {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${env.CF_API_TOKEN}` },
      }
    );
  }
}
```

### VM Cleanup Callback

```bash
#!/bin/bash
# Called by idle-check.sh before self-destruct

# Notify control plane to clean up DNS
curl -sX POST "https://api.${BASE_DOMAIN}/vms/${VM_ID}/cleanup" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"reason": "idle_timeout"}'

# Wait for DNS propagation (optional)
sleep 5

# Self-destruct
${SELF_DELETE_COMMAND}
```

---

## What Needs to Be Built (MVP)

### 1. Cloudflare Worker API

**Endpoints:**
- `POST /vms` - Create VM + DNS
- `GET /vms` - List VMs
- `DELETE /vms/:id` - Delete VM + DNS
- `POST /vms/:id/cleanup` - DNS cleanup callback

**Files:**
- `src/index.ts` - Main worker
- `src/providers/types.ts` - Provider interface
- `src/providers/hetzner.ts` - Hetzner implementation
- `src/dns.ts` - Cloudflare DNS management
- `src/auth.ts` - Bearer token middleware

### 2. Cloud-init Script

**Responsibilities:**
- Install Docker, Node.js, devcontainer CLI
- Install and configure Caddy
- Clone repo and start devcontainer
- Install and start CloudCLI
- Setup idle monitor cron

### 3. Cloudflare Pages UI

**Pages:**
- Dashboard (list VMs)
- Create VM form
- VM detail (status, URLs, delete)

**Tech:** Simple HTML/JS or lightweight framework (Preact, Svelte)

### 4. VM-side Scripts

**Scripts:**
- `/usr/local/bin/idle-check.sh` - Idle detection + cleanup
- Caddy config (static for MVP)

---

## Open Items for Future

1. **Port discovery script** (Phase 2)
2. **R2 integration** (Phase 3)
3. **Cloudflare Tunnel option** (Phase 4)
4. **Cloudflare Access** (Phase 4)
5. **Multi-provider support** (Scaleway, OVH)
6. **GPU providers** (Lambda Labs, Vast.ai)
