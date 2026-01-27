# Quickstart: Browser Terminal SaaS

**Date**: 2026-01-26
**Plan**: [plan.md](./plan.md)

This guide walks you through setting up and deploying the Browser Terminal SaaS platform from scratch.

---

## Prerequisites

Before starting, ensure you have:

| Requirement | Version | Notes |
|-------------|---------|-------|
| Node.js | 20+ | LTS recommended |
| pnpm | 9+ | `npm install -g pnpm` |
| Go | 1.22+ | For building VM Agent |
| Wrangler CLI | Latest | `npm install -g wrangler` |
| GitHub CLI | Latest | `gh auth login` |

**Accounts Required**:
- [Cloudflare](https://cloudflare.com) - Workers, D1, KV, R2, DNS
- [GitHub](https://github.com) - OAuth App + GitHub App
- [Hetzner Cloud](https://hetzner.cloud) - For testing workspace provisioning

---

## 1. Clone and Install

```bash
# Clone the repository
git clone https://github.com/your-org/browser-terminal-saas.git
cd browser-terminal-saas

# Install dependencies
pnpm install

# Verify setup
pnpm build
pnpm test
```

---

## 2. Run the Setup Wizard

The interactive setup wizard guides you through all configuration:

```bash
pnpm setup
```

The wizard will:

1. **Authenticate with Cloudflare**
   ```
   ? Enter your Cloudflare API token: [paste token]
   ? Select your DNS zone: workspaces.example.com
   ```

2. **Create GitHub OAuth App**
   ```
   The wizard will open GitHub in your browser to create an OAuth App.

   Settings to use:
   - Application name: Browser Terminal SaaS (Dev)
   - Homepage URL: http://localhost:5173
   - Authorization callback URL: http://localhost:8787/api/auth/callback/github

   ? Enter the Client ID: [paste]
   ? Enter the Client Secret: [paste]
   ```

3. **Create GitHub App**
   ```
   The wizard will open GitHub in your browser to create a GitHub App.

   Required permissions:
   - Repository: Contents (Read & Write)
   - Repository: Metadata (Read-only)

   Events to subscribe:
   - Installation

   ? Enter the App ID: [paste]
   ? Paste the private key (PEM): [paste multi-line]
   ```

4. **Generate Cryptographic Keys**
   ```
   Generating JWT signing keys (RS256)...
   Generating encryption key (AES-256)...
   ✓ Keys generated and stored
   ```

5. **Create Cloudflare Resources**
   ```
   Creating D1 database: workspaces-dev...
   Creating KV namespace: workspaces-dev-sessions...
   Creating R2 bucket: workspaces-dev-assets...
   Running database migrations...
   ✓ All resources created
   ```

6. **Store Secrets**
   ```
   Setting GITHUB_CLIENT_ID...
   Setting GITHUB_CLIENT_SECRET...
   Setting GITHUB_APP_ID...
   Setting GITHUB_APP_PRIVATE_KEY...
   Setting JWT_PRIVATE_KEY...
   Setting JWT_PUBLIC_KEY...
   Setting ENCRYPTION_KEY...
   ✓ Secrets configured
   ```

---

## 3. Local Development

Start the development servers:

```bash
# Start all services (API + Web + VM Agent UI)
pnpm dev
```

This runs:
- **API**: http://localhost:8787 (Miniflare)
- **Web**: http://localhost:5173 (Vite)
- **VM Agent UI**: http://localhost:5174 (Vite, for UI development)

### Testing Authentication

1. Open http://localhost:5173
2. Click "Sign in with GitHub"
3. Authorize the OAuth App
4. You should land on the dashboard

### Testing with a Real Hetzner Account

1. Go to Settings
2. Add your Hetzner Cloud API token
3. Create a workspace
4. The VM will be provisioned on your Hetzner account

> **Note**: You'll be charged by Hetzner for VM usage. Delete workspaces when done testing.

---

## 4. Build VM Agent

The VM Agent is a Go binary with an embedded React UI:

```bash
# Build the embedded UI first
pnpm --filter vm-agent-ui build

# Build the Go binary
cd packages/vm-agent
make build

# Output: bin/vm-agent-linux-amd64, bin/vm-agent-linux-arm64
```

---

## 5. Deploy to Staging

Deploy the complete platform to staging:

```bash
pnpm deploy:staging
```

This command:
1. Builds all packages
2. Uploads VM Agent binaries to R2
3. Deploys the API Worker
4. Deploys the Web Pages project
5. Runs database migrations

**Staging URLs**:
- API: https://api-staging.workspaces.example.com
- Web: https://staging.workspaces.example.com

### Verify Staging Deployment

```bash
# Check API health
curl https://api-staging.workspaces.example.com/health

# Check VM Agent binary is accessible
curl -I "https://api-staging.workspaces.example.com/api/agent/download?arch=amd64"
```

---

## 6. Deploy to Production

Once staging is verified, deploy to production:

```bash
pnpm deploy
```

**Production URLs**:
- API: https://api.workspaces.example.com
- Web: https://workspaces.example.com

### Production Checklist

Before going live, verify:

- [ ] GitHub OAuth App callback URLs updated for production
- [ ] GitHub App webhook URL updated for production
- [ ] DNS records propagated
- [ ] JWKS endpoint accessible: `/.well-known/jwks.json`
- [ ] VM Agent binary downloadable
- [ ] Create a test workspace and verify terminal access

---

## 7. Teardown

To completely destroy an environment:

```bash
# Staging
pnpm teardown:staging

# Production (requires extra confirmation)
pnpm teardown
```

This removes:
- Cloudflare Worker
- Cloudflare Pages project
- D1 database
- KV namespace
- R2 bucket contents
- DNS records (workspace subdomains)

> **Warning**: This is destructive and irreversible. All user data will be lost.

---

## Environment Configuration

### Local Development (.dev.vars)

```ini
# GitHub OAuth
GITHUB_CLIENT_ID=your_oauth_client_id
GITHUB_CLIENT_SECRET=your_oauth_client_secret

# GitHub App
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

# Cloudflare
CF_API_TOKEN=your_cloudflare_api_token
CF_ZONE_ID=your_zone_id

# JWT Keys (RSA)
JWT_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
JWT_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"

# Encryption
ENCRYPTION_KEY=base64_encoded_32_byte_key

# App Config
BASE_DOMAIN=workspaces.example.com
VERSION=0.1.0
```

### Wrangler Configuration (wrangler.toml)

```toml
name = "workspaces-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"

[env.staging]
name = "workspaces-api-staging"

[[d1_databases]]
binding = "DATABASE"
database_name = "workspaces-dev"
database_id = "your-d1-id"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-id"

[[r2_buckets]]
binding = "R2"
bucket_name = "workspaces-dev-assets"
```

---

## Common Tasks

### Run Database Migrations

```bash
# Development (local)
pnpm db:migrate:local

# Staging
pnpm db:migrate:staging

# Production
pnpm db:migrate
```

### Generate New Keys

```bash
# Regenerate all keys (updates secrets in Cloudflare)
pnpm generate-keys

# Regenerate specific key
pnpm generate-keys --jwt
pnpm generate-keys --encryption
```

### View Logs

```bash
# API logs (Workers)
wrangler tail workspaces-api

# Staging
wrangler tail workspaces-api-staging
```

### Upload VM Agent Manually

```bash
# After building locally
pnpm upload-agent --env staging
pnpm upload-agent --env production
```

---

## Troubleshooting

### "Failed to validate Hetzner token"

- Check the token hasn't expired
- Verify the token has Read/Write permissions for Servers

### "GitHub App installation not found"

- Ensure the GitHub App is installed on the target account/org
- Check the webhook is configured correctly
- Verify the installation webhook was received

### "VM Agent not responding"

1. Check cloud-init logs on the VM:
   ```bash
   ssh root@<vm-ip> 'cat /var/log/cloud-init-output.log'
   ```
2. Check VM Agent logs:
   ```bash
   ssh root@<vm-ip> 'journalctl -u vm-agent'
   ```
3. Verify the control plane URL is reachable from the VM

### "Terminal connection failed"

1. Check the JWT is valid: decode at jwt.io
2. Verify JWKS endpoint is accessible from the VM
3. Check browser console for WebSocket errors

---

## Architecture Overview

```
                    ┌─────────────────────────────────────────────┐
                    │              Cloudflare Edge                 │
                    │  ┌─────────┐  ┌─────────┐  ┌─────────────┐  │
                    │  │ Workers │  │  Pages  │  │     R2      │  │
                    │  │  (API)  │  │  (Web)  │  │  (Binaries) │  │
                    │  └────┬────┘  └────┬────┘  └──────┬──────┘  │
                    │       │            │              │         │
                    │  ┌────┴────┐  ┌────┴────┐        │         │
                    │  │   D1   │  │   KV    │        │         │
                    │  │ (Data) │  │(Sessions)│        │         │
                    │  └────────┘  └─────────┘        │         │
                    └─────────────────────────────────┼─────────┘
                                                      │
                    ┌─────────────────────────────────┼─────────┐
                    │              Hetzner Cloud      │         │
                    │                                 ▼         │
                    │  ┌──────────────────────────────────────┐ │
                    │  │            Workspace VM              │ │
                    │  │  ┌───────────────────────────────┐   │ │
                    │  │  │          VM Agent             │   │ │
                    │  │  │  ┌─────────────────────────┐  │   │ │
                    │  │  │  │   Embedded Terminal UI  │  │   │ │
                    │  │  │  │      (React/xterm)      │  │   │ │
                    │  │  │  └─────────────────────────┘  │   │ │
                    │  │  └───────────────────────────────┘   │ │
                    │  │  ┌───────────────────────────────┐   │ │
                    │  │  │        Devcontainer           │   │ │
                    │  │  │     (User's codebase)         │   │ │
                    │  │  └───────────────────────────────┘   │ │
                    │  └──────────────────────────────────────┘ │
                    └───────────────────────────────────────────┘
```

---

## Next Steps

After completing this quickstart:

1. **Customize the UI**: Edit `apps/web/src/pages/` for branding
2. **Add monitoring**: Integrate with your observability platform
3. **Set up CI/CD**: See `.github/workflows/` for examples
4. **Review security**: Run `pnpm audit` and review the security guide

For more information, see:
- [API Reference](./contracts/api.yaml)
- [VM Agent API](./contracts/agent.yaml)
- [Data Model](./data-model.md)
- [Research Notes](./research.md)
