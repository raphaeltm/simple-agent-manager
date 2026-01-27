# Research: Browser Terminal SaaS MVP

**Date**: 2026-01-26
**Status**: Complete
**Plan**: [plan.md](./plan.md)

This document consolidates research findings for all technical decisions in the implementation plan.

---

## 1. BetterAuth + Cloudflare Configuration

### Decision
Use [better-auth-cloudflare](https://github.com/zpg6/better-auth-cloudflare) package with Hono for authentication.

### Rationale
- Purpose-built integration for Cloudflare Workers, D1, KV
- Official Hono example available at [hono.dev](https://hono.dev/examples/better-auth-on-cloudflare)
- CLI tool for project generation and migration automation
- Handles session management in KV automatically

### Implementation Pattern

```typescript
// apps/api/src/auth.ts
import { Hono } from 'hono';
import { betterAuth } from 'better-auth';
import { withCloudflare } from 'better-auth-cloudflare';
import { drizzle } from 'drizzle-orm/d1';

export function createAuth(env: CloudflareBindings) {
  const db = drizzle(env.DATABASE);

  return betterAuth({
    ...withCloudflare({
      d1: { db, options: { usePlural: true } },
      kv: env.KV,
    }, {
      socialProviders: {
        github: {
          clientId: env.GITHUB_CLIENT_ID,
          clientSecret: env.GITHUB_CLIENT_SECRET,
          scope: ['read:user', 'user:email'],
        },
      },
    }),
  });
}

// apps/api/src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>();

app.on(['GET', 'POST'], '/api/auth/*', (c) => {
  return createAuth(c.env).handler(c.req.raw);
});
```

### Alternatives Considered
- **Lucia Auth**: More manual setup, less Cloudflare-specific
- **Auth.js**: Heavier, more oriented toward Next.js
- **Custom JWT**: More work, reinventing the wheel

### Sources
- [Hono BetterAuth Example](https://hono.dev/examples/better-auth-on-cloudflare)
- [better-auth-cloudflare GitHub](https://github.com/zpg6/better-auth-cloudflare)
- [BetterAuth Hono Integration](https://www.better-auth.com/docs/integrations/hono)

---

## 2. GitHub App Implementation

### Decision
Create a GitHub App (not OAuth App) for repository access with installation tokens.

### Rationale
- OAuth tokens cannot reliably perform git clone/push operations
- GitHub Apps provide fine-grained permissions
- Installation access tokens work for git operations
- Tokens expire after 1 hour (acceptable for initial clone)

### Token Generation Flow

1. **Generate JWT** from App private key
2. **Get Installation ID** from user's installation
3. **POST /app/installations/{id}/access_tokens** to get token

```typescript
// apps/api/src/services/github-app.ts
import { SignJWT, importPKCS8 } from 'jose';

async function generateAppJWT(env: CloudflareBindings): Promise<string> {
  const privateKey = await importPKCS8(env.GITHUB_APP_PRIVATE_KEY, 'RS256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setIssuer(env.GITHUB_APP_ID)
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function getInstallationToken(
  installationId: string,
  env: CloudflareBindings
): Promise<string> {
  const jwt = await generateAppJWT(env);

  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${jwt}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  const data = await response.json();
  return data.token;
}
```

### Git Clone with Token

```bash
git clone https://x-access-token:${TOKEN}@github.com/owner/repo.git
```

### Alternatives Considered
- **OAuth App + PAT**: Requires user to create and share PAT manually
- **GitHub OAuth token for git**: Unreliable, not officially supported

### Sources
- [GitHub: Generating Installation Access Token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [GitHub: Authenticating as Installation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)

---

## 3. Hetzner Cloud API Patterns

### Decision
Use Hetzner Cloud API v1 with cloud-init for VM provisioning.

### Rationale
- Simple REST API with good documentation
- cloud-init support via `user_data` parameter
- Reasonable rate limits for our use case

### Server Creation

```typescript
// apps/api/src/services/hetzner.ts
interface CreateServerRequest {
  name: string;
  server_type: string;  // 'cx22', 'cx32', 'cx42'
  location: string;     // 'nbg1', 'fsn1', 'hel1'
  image: string;        // 'ubuntu-24.04'
  user_data: string;    // cloud-init config (max 32KB)
  labels: Record<string, string>;
}

async function createServer(
  config: CreateServerRequest,
  hetznerToken: string
): Promise<{ id: number; ip: string }> {
  const response = await fetch('https://api.hetzner.cloud/v1/servers', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${hetznerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(config),
  });

  const data = await response.json();
  return {
    id: data.server.id,
    ip: data.server.public_net.ipv4.ip,
  };
}
```

### Server Types Mapping

| Size | Hetzner Type | vCPUs | RAM | Description |
|------|-------------|-------|-----|-------------|
| small | cx22 | 2 | 4GB | Light development |
| medium | cx32 | 4 | 8GB | Standard development |
| large | cx42 | 8 | 16GB | Heavy workloads |

### Rate Limits
- 3600 requests per hour per API token
- Sufficient for our use case

### Sources
- [Hetzner Cloud API Docs](https://docs.hetzner.cloud/)
- [Hetzner: Creating a Server](https://docs.hetzner.com/cloud/servers/getting-started/creating-a-server/)

---

## 4. Cloudflare DNS API

### Decision
Use Cloudflare DNS API to create dynamic workspace subdomains.

### Rationale
- Already using Cloudflare for Workers/Pages
- Fast DNS propagation
- Proxy mode provides DDoS protection

### DNS Record Management

```typescript
// apps/api/src/services/dns.ts
async function createDNSRecord(
  workspaceId: string,
  ip: string,
  env: CloudflareBindings
): Promise<string> {
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
        name: `ws-${workspaceId}`,  // ws-abc123.workspaces.example.com
        content: ip,
        ttl: 60,      // 1 minute for fast updates
        proxied: true, // Enable Cloudflare proxy for HTTPS
      }),
    }
  );

  const data = await response.json();
  return data.result.id;  // Store for later deletion
}

async function deleteDNSRecord(
  recordId: string,
  env: CloudflareBindings
): Promise<void> {
  await fetch(
    `https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
      },
    }
  );
}
```

### Proxied vs Direct
- **Proxied (orange cloud)**: HTTPS termination, DDoS protection, caching
- **Direct (gray cloud)**: Direct connection to origin

We use **proxied** for workspace subdomains to get automatic HTTPS.

---

## 5. Go PTY and WebSocket Patterns

### Decision
Use [creack/pty](https://github.com/creack/pty) for PTY management and [gorilla/websocket](https://github.com/gorilla/websocket) for WebSocket handling.

### Rationale
- creack/pty is the de facto standard Go PTY library
- gorilla/websocket is mature and well-maintained
- Both work well together for terminal applications

### Terminal Session Pattern

```go
// packages/vm-agent/internal/pty/session.go
package pty

import (
    "os"
    "os/exec"
    "syscall"

    "github.com/creack/pty"
    "github.com/gorilla/websocket"
)

type Session struct {
    ptmx *os.File
    cmd  *exec.Cmd
    conn *websocket.Conn
}

func NewSession(conn *websocket.Conn) (*Session, error) {
    cmd := exec.Command("devcontainer", "exec",
        "--workspace-folder", "/workspace", "bash")

    ptmx, err := pty.Start(cmd)
    if err != nil {
        return nil, err
    }

    return &Session{
        ptmx: ptmx,
        cmd:  cmd,
        conn: conn,
    }, nil
}

func (s *Session) HandleResize(rows, cols uint16) error {
    return pty.Setsize(s.ptmx, &pty.Winsize{
        Rows: rows,
        Cols: cols,
    })
}

func (s *Session) ReadLoop() {
    buf := make([]byte, 1024)
    for {
        n, err := s.ptmx.Read(buf)
        if err != nil {
            return
        }
        s.conn.WriteMessage(websocket.BinaryMessage, buf[:n])
    }
}

func (s *Session) WriteLoop() {
    for {
        _, data, err := s.conn.ReadMessage()
        if err != nil {
            return
        }
        s.ptmx.Write(data)
    }
}
```

### WebSocket Protocol
- **Binary frames**: Terminal I/O data
- **Text frames (JSON)**: Control messages (resize, heartbeat)

```json
// Resize message
{"type": "resize", "rows": 24, "cols": 80}

// Heartbeat
{"type": "ping"}
{"type": "pong"}
```

### Sources
- [creack/pty GitHub](https://github.com/creack/pty)
- [gorilla/websocket GitHub](https://github.com/gorilla/websocket)
- [cmdr-pty WebSocket Wrapper](https://github.com/updroidinc/cmdr-pty)

---

## 6. JWT/JWKS in Workers and Go

### Decision
Use RS256 algorithm with JWKS endpoint for JWT validation.

### Rationale
- RS256 allows public key validation (JWKS)
- VM Agent can validate without shared secrets
- JWKS supports key rotation

### Control Plane JWT Signing (Workers)

```typescript
// apps/api/src/services/jwt.ts
import { SignJWT, importPKCS8, exportJWK, importSPKI } from 'jose';

async function signTerminalToken(
  userId: string,
  workspaceId: string,
  env: CloudflareBindings
): Promise<string> {
  const privateKey = await importPKCS8(env.JWT_PRIVATE_KEY, 'RS256');

  return new SignJWT({
    workspace: workspaceId,
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'key-2026-01' })
    .setIssuer('https://api.workspaces.example.com')
    .setSubject(userId)
    .setAudience('workspace-terminal')
    .setExpirationTime('1h')
    .sign(privateKey);
}

// JWKS endpoint
async function getJWKS(env: CloudflareBindings) {
  const publicKey = await importSPKI(env.JWT_PUBLIC_KEY, 'RS256');
  const jwk = await exportJWK(publicKey);

  return {
    keys: [{
      ...jwk,
      kid: 'key-2026-01',
      use: 'sig',
      alg: 'RS256',
    }],
  };
}
```

### VM Agent JWT Validation (Go)

```go
// packages/vm-agent/internal/auth/jwt.go
package auth

import (
    "github.com/golang-jwt/jwt/v5"
    "github.com/MicahParks/keyfunc/v3"
)

type Claims struct {
    Workspace string `json:"workspace"`
    jwt.RegisteredClaims
}

func NewValidator(jwksURL string) (*Validator, error) {
    jwks, err := keyfunc.NewDefaultCtx(context.Background(), []string{jwksURL})
    if err != nil {
        return nil, err
    }
    return &Validator{jwks: jwks}, nil
}

func (v *Validator) Validate(tokenString string, workspaceId string) (*Claims, error) {
    token, err := jwt.ParseWithClaims(tokenString, &Claims{}, v.jwks.Keyfunc)
    if err != nil {
        return nil, err
    }

    claims := token.Claims.(*Claims)
    if claims.Workspace != workspaceId {
        return nil, errors.New("workspace mismatch")
    }

    return claims, nil
}
```

### Sources
- [jose npm package](https://github.com/panva/jose)
- [golang-jwt/jwt](https://github.com/golang-jwt/jwt)
- [MicahParks/keyfunc](https://github.com/MicahParks/keyfunc)

---

## 7. AES-GCM in Web Crypto API

### Decision
Use Web Crypto API with AES-256-GCM for credential encryption.

### Rationale
- Native to Workers runtime (no dependencies)
- AES-GCM provides authenticated encryption
- 256-bit key for strong security

### Encryption Pattern

```typescript
// apps/api/src/services/encryption.ts
async function encrypt(
  plaintext: string,
  keyBase64: string
): Promise<{ ciphertext: string; iv: string }> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoded
  );

  return {
    ciphertext: bufferToBase64(ciphertext),
    iv: bufferToBase64(iv),
  };
}

async function decrypt(
  ciphertext: string,
  iv: string,
  keyBase64: string
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    base64ToBuffer(keyBase64),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );

  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBuffer(iv) },
    key,
    base64ToBuffer(ciphertext)
  );

  return new TextDecoder().decode(decrypted);
}

// Helpers
function bufferToBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(base64: string): ArrayBuffer {
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer;
}
```

### Key Generation (setup script)

```typescript
// scripts/generate-keys.ts
const key = crypto.getRandomValues(new Uint8Array(32)); // 256 bits
const keyBase64 = Buffer.from(key).toString('base64');
console.log('ENCRYPTION_KEY:', keyBase64);
```

### Sources
- [Cloudflare Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)
- [Web Crypto API AES-GCM Example](https://gist.github.com/chrisveness/43bcda93af9f646d083fad678071b90a)

---

## 8. R2 Binary Storage

### Decision
Store VM Agent binaries in R2, serve via Worker endpoint.

### Rationale
- Self-contained deployment (no GitHub dependency)
- Version alignment with control plane
- Cache headers for efficiency

### Upload Binary (deploy script)

```typescript
// scripts/upload-agent.ts
async function uploadAgentBinary(
  env: string,
  arch: 'amd64' | 'arm64'
): Promise<void> {
  const binary = await fs.readFile(`packages/vm-agent/bin/vm-agent-linux-${arch}`);
  const version = getPackageVersion();

  await r2.put(`agent/${version}/vm-agent-linux-${arch}`, binary, {
    httpMetadata: {
      contentType: 'application/octet-stream',
      contentDisposition: `attachment; filename="vm-agent-linux-${arch}"`,
    },
    customMetadata: {
      version,
    },
  });
}
```

### Serve Binary (Worker)

```typescript
// apps/api/src/routes/agent.ts
app.get('/agent/download', async (c) => {
  const arch = c.req.query('arch') || 'amd64';
  const version = c.env.VERSION; // Set during deploy

  const object = await c.env.R2.get(`agent/${version}/vm-agent-linux-${arch}`);
  if (!object) {
    return c.text('Not found', 404);
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="vm-agent-linux-${arch}"`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Agent-Version': version,
    },
  });
});
```

### Cloud-Init Download

```yaml
runcmd:
  - |
    ARCH=$(uname -m)
    case $ARCH in
      x86_64) ARCH="amd64" ;;
      aarch64) ARCH="arm64" ;;
    esac
    curl -Lo /usr/local/bin/vm-agent "${CONTROL_PLANE_URL}/agent/download?arch=${ARCH}"
    chmod +x /usr/local/bin/vm-agent
```

### Sources
- [Cloudflare R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-usage/)
- [R2 Download Objects](https://developers.cloudflare.com/r2/objects/download-objects/)

---

## Summary

All research topics have been resolved. Key decisions:

| Topic | Decision |
|-------|----------|
| Auth | BetterAuth + better-auth-cloudflare + GitHub OAuth |
| Repo Access | GitHub App with installation tokens |
| VM Provisioning | Hetzner API with cloud-init |
| DNS | Cloudflare DNS API with proxied records |
| Terminal | creack/pty + gorilla/websocket |
| JWT | RS256 with JWKS endpoint |
| Encryption | AES-256-GCM via Web Crypto API |
| Agent Distribution | R2 bucket served by Worker |

Ready for Phase 1: Data Model and Contracts.
