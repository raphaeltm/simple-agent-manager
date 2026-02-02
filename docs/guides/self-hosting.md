# Self-Hosting Guide

This comprehensive guide walks you through deploying Simple Agent Manager (SAM) to your own infrastructure. Follow each section carefully—skipping steps is the most common cause of deployment issues.

---

## Quick Start (Automated Deployment)

For the fastest deployment experience, use the automated GitHub Actions workflow with Pulumi infrastructure management. **Deployment is automatic on every push to main.**

**For detailed step-by-step instructions, see the [Quickstart Guide](../../specs/005-automated-deployment/quickstart.md)**.

### Prerequisites (One-Time Setup)

1. **Fork this repository**
2. **Have a domain configured in Cloudflare** with nameservers pointing to Cloudflare
3. **Create a Cloudflare API Token** with these permissions:
   - Account: D1, Workers KV Storage, Workers R2 Storage, Workers Scripts, Cloudflare Pages (Edit)
   - Zone: DNS (Edit), Zone (Read)
4. **Note your Account ID and Zone ID** from the Cloudflare dashboard (domain overview, right sidebar)
5. **Create an R2 API Token** (separate from above - for Pulumi state storage):
   - Go to Cloudflare Dashboard → R2 → **Manage R2 API Tokens**
   - Create token with **Object Read & Write** permissions
   - Note: The state bucket is created automatically by the workflow
6. **Create GitHub OAuth App and GitHub App** (see [GitHub Setup](#github-setup) below)
7. **Generate a Pulumi passphrase** for encrypting state:
   ```bash
   openssl rand -base64 32
   ```

### GitHub Environment Configuration

All configuration lives in a **GitHub Environment** named `production`. This makes configuration visible and editable in the GitHub UI.

**Create the environment:**
1. Go to your fork's **Settings → Environments**
2. Click **New environment**
3. Name it `production` and click **Configure environment**

**Add environment variables** (visible in UI):

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_DOMAIN` | Your domain for the deployment | `example.com` |
| `RESOURCE_PREFIX` | Prefix for Cloudflare resources (optional) | `sam` |
| `PULUMI_STATE_BUCKET` | R2 bucket for Pulumi state (optional) | `sam-pulumi-state` |

**Add environment secrets** (hidden):

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token with D1, KV, R2, DNS, Workers permissions |
| `CF_ACCOUNT_ID` | Your Cloudflare account ID (32-char hex) |
| `CF_ZONE_ID` | Your domain's zone ID (32-char hex) |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret key |
| `PULUMI_CONFIG_PASSPHRASE` | Your generated passphrase |
| `GH_CLIENT_ID` | GitHub OAuth App client ID |
| `GH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GH_APP_ID` | GitHub App ID |
| `GH_APP_PRIVATE_KEY` | GitHub App private key (base64 encoded) |
| `GH_APP_SLUG` | GitHub App slug (URL name) |

> **Naming Convention**: GitHub secrets use `GH_*` prefix (not `GITHUB_*`) because GitHub reserves `GITHUB_*` for its own variables. The deployment workflow automatically maps `GH_*` → `GITHUB_*` when setting Cloudflare Worker secrets.

> **Note**: Security keys (`ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`) are **automatically generated** on first deployment and stored directly in Cloudflare Worker secrets. For persistence across fresh deployments, copy them to GitHub Secrets after first deployment.

### Deploy

**Automatic deployment**: Every push to `main` triggers a deployment automatically.

**First deployment**:
1. Configure the GitHub Environment (see above)
2. Push any commit to `main`, OR
3. Go to **Actions** → **"Deploy"** → **"Run workflow"** for manual trigger

**Subsequent deployments**: Just merge PRs to `main`. The workflow:
- Validates all required configuration exists
- Provisions infrastructure via Pulumi (idempotent)
- Deploys API Worker and Web UI via Wrangler
- Runs database migrations
- Builds and uploads VM Agent binaries
- Runs health check

### Teardown

To remove all resources:
1. Go to **Actions** → **"Teardown"**
2. Click **"Run workflow"**
3. Type `DELETE` to confirm
4. Click **"Run workflow"**

For more control or troubleshooting, continue with the manual setup below.

---

## Table of Contents

1. [Prerequisites & Preparation](#prerequisites--preparation)
2. [Cloudflare Setup](#cloudflare-setup)
3. [GitHub Setup](#github-setup)
4. [Project Setup](#project-setup)
5. [Building & Deployment](#building--deployment)
6. [DNS Configuration](#dns-configuration)
7. [Verification](#verification)
8. [Maintenance](#maintenance)
9. [Troubleshooting](#troubleshooting)
10. [Cost Estimation](#cost-estimation)

---

## Prerequisites & Preparation

Before starting, ensure you have the following ready.

### Required Accounts

| Account | Purpose | Tier Needed | Sign-up Link |
|---------|---------|-------------|--------------|
| **Cloudflare** | API hosting, DNS, storage | Free tier | [cloudflare.com](https://dash.cloudflare.com/sign-up) |
| **GitHub** | Authentication, repository access | Free tier | [github.com](https://github.com/signup) |
| **Domain Registrar** | Your workspace domain | Any | (you likely already have one) |

**Note**: Hetzner Cloud accounts are created per-user. Users provide their own Hetzner API token to create workspaces, so you don't need a shared Hetzner account.

### Required Tools

Install these on your development machine:

```bash
# Node.js 20+ (check version)
node --version  # Should be v20.x or higher

# pnpm 9+ (install if missing)
npm install -g pnpm
pnpm --version  # Should be 9.x or higher

# Go 1.22+ (required for VM Agent compilation)
go version  # Should be go1.22.x or higher

# Git
git --version
```

**Installing Go** (if not installed):
- **macOS**: `brew install go`
- **Ubuntu/Debian**: `sudo apt install golang-go` (or use [official installer](https://go.dev/dl/))
- **Windows**: Download from [go.dev/dl](https://go.dev/dl/)

### Preparation Checklist

- [ ] All required accounts created
- [ ] All tools installed and verified
- [ ] A domain you control (e.g., `example.com` or `workspaces.example.com`)
- [ ] 30-60 minutes of uninterrupted time

---

## Cloudflare Setup

This section covers setting up Cloudflare as your infrastructure provider.

### Step 1: Add Your Domain to Cloudflare

If your domain is not already on Cloudflare:

1. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com)
2. Click **"Add a Site"** (or **"Add site"** button)
3. Enter your domain (e.g., `example.com`) and click **Continue**
4. Select the **Free** plan and click **Continue**
5. Cloudflare will scan your existing DNS records—review and click **Continue**
6. **Important**: Note the two nameservers Cloudflare assigns (e.g., `ivy.ns.cloudflare.com`, `rudy.ns.cloudflare.com`)

### Step 2: Update Nameservers at Your Registrar

You must point your domain to Cloudflare's nameservers. This varies by registrar:

**GoDaddy:**
1. Go to [my.godaddy.com](https://my.godaddy.com) → **My Products** → **DNS**
2. Click **Nameservers** → **Change** → **Enter custom nameservers**
3. Enter Cloudflare's nameservers, click **Save**

**Namecheap:**
1. Go to [namecheap.com](https://www.namecheap.com) → **Domain List** → **Manage**
2. Under **Nameservers**, select **Custom DNS**
3. Enter Cloudflare's nameservers, click **Save**

**Google Domains / Squarespace Domains:**
1. Go to [domains.squarespace.com](https://domains.squarespace.com)
2. Select your domain → **DNS** → **Nameservers** → **Use custom nameservers**
3. Enter Cloudflare's nameservers

**Other Registrars**: Look for "Nameservers" or "DNS Settings" in your registrar's dashboard.

**Important**: Nameserver changes can take up to 24 hours to propagate. Cloudflare will email you when the domain is active.

### Step 3: Find Your Account ID and Zone ID

You'll need these IDs for configuration:

1. In Cloudflare Dashboard, select your domain
2. Scroll down on the **Overview** page
3. In the right sidebar under **API**, you'll see:
   - **Zone ID**: Copy this (32-character hex string)
   - **Account ID**: Copy this (32-character hex string)

Save these values—you'll need them later.

### Step 4: Create API Token with Required Permissions

SAM needs a Cloudflare API token with specific permissions:

1. Go to **My Profile** (top-right icon) → **API Tokens**
2. Click **"Create Token"**
3. Click **"Create Custom Token"** (not a template)
4. Configure the token:

**Token name**: `simple-agent-manager`

**Permissions** (add all of these):

| Permission Type | Resource | Access Level |
|-----------------|----------|--------------|
| **Account** | Cloudflare Workers:D1 | Edit |
| **Account** | Workers KV Storage | Edit |
| **Account** | Workers R2 Storage | Edit |
| **Account** | Workers Scripts | Edit |
| **Zone** | DNS | Edit |
| **Zone** | Zone | Read |

**Zone Resources**: Select **Include** → **Specific zone** → *your domain*

**Account Resources**: Select **Include** → **Your account name**

5. Click **Continue to summary** → **Create Token**
6. **Copy the token immediately**—it won't be shown again

### Step 5: Create Cloudflare Resources

> **Note**: If using the [Quick Start (Automated Deployment)](#quick-start-automated-deployment), skip this step. Pulumi automatically creates D1, KV, and R2 resources when you push to main.

<details>
<summary>Manual resource creation (optional)</summary>

Open your terminal and run these commands:

```bash
# Login to Cloudflare via Wrangler
npx wrangler login

# Create D1 Database
npx wrangler d1 create workspaces
# Note the database_id from the output!

# Create KV Namespace for sessions
npx wrangler kv:namespace create sessions
# Note the namespace id from the output!

# Create R2 Bucket for VM Agent binaries
npx wrangler r2 bucket create workspaces-assets
```

**Save these IDs** from the command outputs:
- D1 Database ID (e.g., `abc123...`)
- KV Namespace ID (e.g., `def456...`)

</details>

---

## GitHub Setup

SAM requires two separate GitHub applications:
1. **OAuth App**: For user login
2. **GitHub App**: For repository access with fine-grained permissions

### Step 1: Create GitHub OAuth App (for Login)

1. Go to [GitHub Developer Settings](https://github.com/settings/developers)
2. Click **"OAuth Apps"** → **"New OAuth App"**
3. Fill in the form:

| Field | Value |
|-------|-------|
| **Application name** | Simple Agent Manager Login |
| **Homepage URL** | `https://app.YOUR_DOMAIN.com` |
| **Authorization callback URL** | `https://api.YOUR_DOMAIN.com/api/auth/callback/github` |

4. Click **"Register application"**
5. Copy the **Client ID**
6. Click **"Generate a new client secret"** and copy it immediately

**Important**: OAuth apps only support ONE callback URL. You'll need separate apps for development and production.

### Step 2: Create GitHub App (for Repository Access)

1. Go to [GitHub App Settings](https://github.com/settings/apps)
2. Click **"New GitHub App"**
3. Fill in the form:

**Basic Information:**
| Field | Value |
|-------|-------|
| **GitHub App name** | Simple Agent Manager |
| **Homepage URL** | `https://app.YOUR_DOMAIN.com` |

**Identifying and authorizing users:**
| Field | Value |
|-------|-------|
| **Callback URL** | `https://api.YOUR_DOMAIN.com/api/github/callback` |
| **Expire user authorization tokens** | ✓ Checked |
| **Request user authorization (OAuth) during installation** | ✓ Checked |
| **Enable Device Flow** | ☐ Unchecked |

**Post installation:**
| Field | Value |
|-------|-------|
| **Setup URL (optional)** | `https://app.YOUR_DOMAIN.com/settings` |
| **Redirect on update** | ✓ Checked |

**Webhook:**
| Field | Value |
|-------|-------|
| **Active** | ✓ Checked |
| **Webhook URL** | `https://api.YOUR_DOMAIN.com/api/github/webhook` |
| **Webhook secret** | Generate a random string (save it!) |

**Repository permissions:**
| Permission | Access |
|------------|--------|
| **Contents** | Read-only |
| **Metadata** | Read-only |

**Account permissions**: None needed

**Where can this GitHub App be installed?**: Select based on your needs:
- **Only on this account**: For personal use
- **Any account**: For public/team use

4. Click **"Create GitHub App"**
5. Note the **App ID** (number shown at top)

### Step 3: Generate GitHub App Private Key

1. On the GitHub App page, scroll to **"Private keys"**
2. Click **"Generate a private key"**
3. A `.pem` file will download automatically
4. Save this file securely—you'll need it for configuration

---

## Project Setup

### Step 1: Clone and Install

```bash
# Clone the repository
git clone https://github.com/YOUR_ORG/simple-agent-manager.git
cd simple-agent-manager

# Install dependencies
pnpm install
```

### Step 2: Generate Security Keys

```bash
# Generate JWT and encryption keys
pnpm generate-keys --env >> keys.txt

# View the generated keys
cat keys.txt
```

This generates:
- **ENCRYPTION_KEY**: AES-256 key for encrypting stored credentials
- **JWT_PRIVATE_KEY**: RSA private key for signing terminal access tokens
- **JWT_PUBLIC_KEY**: RSA public key for token verification
- **JWT_KEY_ID**: Key identifier for JWKS endpoint

### Step 3: Configure Environment Variables (Local Development)

> **Note**: For production deployment via GitHub Actions, use [GitHub Environment Configuration](#github-environment-configuration) instead. This step is only needed for local development.

> **Naming Convention**: Local `.env` files use `GITHUB_*` prefix (e.g., `GITHUB_CLIENT_ID`) because that's what the Worker code reads. This differs from GitHub Environment secrets which use `GH_*` prefix. The deployment workflow maps between them.

Create your `.env` file:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
# Cloudflare Configuration
CF_API_TOKEN=your-cloudflare-api-token-from-step-4
CF_ZONE_ID=your-zone-id-from-step-3
CF_ACCOUNT_ID=your-account-id-from-step-3

# Domain Configuration
# Use your workspace subdomain (workspaces will be ws-xxx.workspaces.example.com)
BASE_DOMAIN=workspaces.example.com

# GitHub OAuth App (from OAuth App setup)
GITHUB_CLIENT_ID=Iv1.xxxxxxxxxxxx
GITHUB_CLIENT_SECRET=your-oauth-client-secret

# GitHub App (from GitHub App setup)
GITHUB_APP_ID=123456
# For the private key, base64 encode the entire .pem file:
# cat your-key.pem | base64 -w0
GITHUB_APP_PRIVATE_KEY=LS0tLS1CRUdJTi4uLi4=

# Security Keys (from pnpm generate-keys)
ENCRYPTION_KEY=your-encryption-key-from-generate-keys
JWT_PRIVATE_KEY=your-jwt-private-key
JWT_PUBLIC_KEY=your-jwt-public-key
JWT_KEY_ID=key-2026-01
```

### Step 4: Update wrangler.toml

> **Note**: If using the [Quick Start (Automated Deployment)](#quick-start-automated-deployment), skip this step. The `sync-wrangler-config.ts` script automatically updates wrangler.toml with Pulumi-provisioned resource IDs.

<details>
<summary>Manual configuration (for local development or manual deployment)</summary>

Edit `apps/api/wrangler.toml` with your resource IDs:

```toml
name = "workspaces-api"
main = "src/index.ts"
compatibility_date = "2024-01-01"
compatibility_flags = ["nodejs_compat"]

[vars]
BASE_DOMAIN = "workspaces.example.com"  # Your domain
VERSION = "1.0.0"

# D1 Database (use your database_id from Step 5)
[[d1_databases]]
binding = "DATABASE"
database_name = "workspaces"
database_id = "your-d1-database-id-here"

# KV Namespace (use your namespace id from Step 5)
[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id-here"

# R2 Bucket
[[r2_buckets]]
binding = "R2"
bucket_name = "workspaces-assets"

# Cron for provisioning timeout checks
[triggers]
crons = ["*/5 * * * *"]
```

</details>

---

## Building & Deployment

> **Recommended**: Use the [Quick Start (Automated Deployment)](#quick-start-automated-deployment) for the easiest deployment experience. The GitHub Actions workflow handles all build, deploy, and configuration steps automatically.

The manual steps below are provided for local development, custom deployments, or troubleshooting.

<details>
<summary>Manual Deployment Steps</summary>

### Step 1: Build All Packages

```bash
# Build TypeScript packages
pnpm build
```

### Step 2: Build VM Agent (Go)

The VM Agent runs on workspace VMs and requires compilation:

```bash
cd packages/vm-agent

# Install Go dependencies
go mod download

# Build for Linux (VMs use Linux)
make build-all
```

This creates binaries in `packages/vm-agent/bin/`:
- `vm-agent-linux-amd64`
- `vm-agent-linux-arm64`
- `vm-agent-darwin-amd64` (for local testing)
- `vm-agent-darwin-arm64` (for local testing)

### Step 3: Set Cloudflare Worker Secrets

Secrets must be set separately (not in wrangler.toml):

```bash
cd apps/api

# Set each secret (you'll be prompted for the value)
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ZONE_ID
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put ENCRYPTION_KEY
wrangler secret put JWT_PRIVATE_KEY
wrangler secret put JWT_PUBLIC_KEY
```

**Tip**: For multiline values (like private keys), you can pipe them:
```bash
cat path/to/github-app-key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY
```

### Step 4: Run Database Migrations

```bash
# Apply migrations to production D1
wrangler d1 migrations apply workspaces --remote
```

### Step 5: Deploy API

```bash
cd apps/api
wrangler deploy
```

Note the deployed URL (e.g., `workspaces-api.your-subdomain.workers.dev`)

### Step 6: Deploy Web UI

```bash
cd apps/web
pnpm build
wrangler pages deploy dist --project-name simple-agent-manager
```

If this is your first Pages deployment, Wrangler will create the project. Note the URL (e.g., `simple-agent-manager.pages.dev`).

### Step 7: Upload VM Agent to R2

```bash
cd packages/vm-agent

# Upload each binary
wrangler r2 object put workspaces-assets/agents/vm-agent-linux-amd64 --file bin/vm-agent-linux-amd64
wrangler r2 object put workspaces-assets/agents/vm-agent-linux-arm64 --file bin/vm-agent-linux-arm64

# Upload version info
echo '{"version": "1.0.0", "buildDate": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > bin/version.json
wrangler r2 object put workspaces-assets/agents/version.json --file bin/version.json
```

</details>

---

## DNS Configuration

> **Note**: If using the [Quick Start (Automated Deployment)](#quick-start-automated-deployment), DNS records are created automatically by Pulumi. This section is for manual deployment or reference.

Configure DNS records in Cloudflare to route traffic to your deployments.

### Required DNS Records

In Cloudflare Dashboard → your domain → **DNS**:

| Type | Name | Content | Proxy Status |
|------|------|---------|--------------|
| CNAME | `api` | `workspaces-api.your-subdomain.workers.dev` | Proxied (orange) |
| CNAME | `app` | `simple-agent-manager.pages.dev` | Proxied (orange) |
| A | `*` | `192.0.2.0` | Proxied (orange) |

**Notes**:
- The `*` (wildcard) record catches workspace subdomains (e.g., `ws-abc123.workspaces.example.com`)
- The dummy IP `192.0.2.0` is fine because the Workers handle routing
- All records should be **proxied** (orange cloud) for SSL and Workers routing

### SSL/TLS Configuration

1. In Cloudflare Dashboard → your domain → **SSL/TLS**
2. Set encryption mode to **Full (strict)**
3. Under **Edge Certificates**, ensure:
   - **Always Use HTTPS**: On
   - **Automatic HTTPS Rewrites**: On

Cloudflare automatically provisions SSL certificates including wildcard (`*.workspaces.example.com`).

---

## Verification

Test each component to ensure everything works.

### Test 1: API Health Check

```bash
curl https://api.YOUR_DOMAIN.com/api/health
# Should return: {"status":"ok"}
```

### Test 2: Web UI Access

Open `https://app.YOUR_DOMAIN.com` in your browser. You should see the login page.

### Test 3: GitHub OAuth Login

1. Click "Sign in with GitHub"
2. Authorize the OAuth application
3. You should be redirected back and see the dashboard

### Test 4: Agent Binary Download

```bash
curl -I "https://api.YOUR_DOMAIN.com/api/agent/download?os=linux&arch=amd64"
# Should return: HTTP/2 200 with Content-Type: application/octet-stream
```

### Test 5: Create a Workspace (Full E2E)

1. Add your Hetzner API token in Settings
2. Install the GitHub App on a test repository
3. Create a workspace from the dashboard
4. Wait for provisioning (2-5 minutes)
5. Connect to the terminal

---

## Maintenance

### Viewing Logs

```bash
# Stream real-time logs
wrangler tail

# Filter to errors only
wrangler tail --format=pretty --filter error
```

### Updating the VM Agent

When you make changes to the VM Agent:

```bash
cd packages/vm-agent
make build-all

# Re-upload to R2
wrangler r2 object put workspaces-assets/agents/vm-agent-linux-amd64 --file bin/vm-agent-linux-amd64
wrangler r2 object put workspaces-assets/agents/vm-agent-linux-arm64 --file bin/vm-agent-linux-arm64

# Update version
echo '{"version": "1.0.1", "buildDate": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}' > bin/version.json
wrangler r2 object put workspaces-assets/agents/version.json --file bin/version.json
```

### Database Migrations

When schema changes are needed:

```bash
# Create a new migration
wrangler d1 migrations create workspaces your-migration-name

# Apply to production
wrangler d1 migrations apply workspaces --remote
```

### Rotating Security Keys

Generate new keys and update secrets:

```bash
pnpm generate-keys --env

# Update the secrets
cd apps/api
wrangler secret put JWT_PRIVATE_KEY
wrangler secret put JWT_PUBLIC_KEY
wrangler secret put ENCRYPTION_KEY
```

**Warning**: Rotating JWT keys will invalidate all active terminal sessions.

---

## Troubleshooting

### Pulumi & Automated Deployment Issues

#### "error: failed to decrypt state"

**Cause**: `PULUMI_CONFIG_PASSPHRASE` doesn't match the one used when state was created.

**Fix**:
1. Use the same passphrase used during initial deployment
2. If you lost the passphrase, delete the stack in R2 and start fresh:
   ```bash
   # In Cloudflare Dashboard → R2 → sam-pulumi-state bucket
   # Delete the .pulumi/ folder for your stack
   ```

#### "error: failed to load checkpoint"

**Cause**: R2 backend connection failed or bucket doesn't exist.

**Fix**:
1. Verify the Pulumi state bucket exists in Cloudflare R2
2. Check R2 credentials (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`) in your GitHub Environment
3. Verify the bucket name matches the `PULUMI_STATE_BUCKET` environment variable (default: `sam-pulumi-state`)

#### "error: stack 'prod' not found"

**Cause**: First deployment or stack was removed.

**Fix**: This is normal for first deployments. The workflow automatically creates the stack. If you see this after a previous deployment, the state may have been deleted.

#### "error: resource already exists"

**Cause**: Resource was created outside Pulumi or imported incorrectly.

**Fix**:
1. If the resource should be managed by Pulumi, import it:
   ```bash
   pulumi import cloudflare:index/d1Database:D1Database sam-database <database-id>
   ```
2. Or delete the resource in Cloudflare Dashboard and re-run deployment

#### "Deployment succeeded but health check failed"

**Cause**: Worker deployed but configuration issue preventing startup.

**Fix**:
1. Check worker logs: `wrangler tail`
2. Verify all secrets are set correctly
3. Check D1 migrations were applied

---

### "OAuth callback failed"

**Cause**: Callback URL mismatch

**Fix**:
1. Check your GitHub OAuth App callback URL matches exactly: `https://api.YOUR_DOMAIN.com/api/auth/callback/github`
2. Ensure HTTPS is used (not HTTP)
3. Verify the domain in Cloudflare is active

### "D1_ERROR: no such table"

**Cause**: Migrations haven't been applied

**Fix**:
```bash
wrangler d1 migrations apply workspaces --remote
```

### "Failed to download agent binary"

**Cause**: R2 bucket not configured or binaries not uploaded

**Fix**:
1. Verify R2 bucket exists: `wrangler r2 bucket list`
2. Re-upload binaries (see Step 7 above)

### "Workspace stuck in provisioning"

**Cause**: VM provisioning failed or agent didn't start

**Fix**:
1. Check Hetzner console for VM status
2. If VM is running, SSH in and check: `systemctl status vm-agent`
3. View cloud-init logs: `cat /var/log/cloud-init-output.log`

### "JWT verification failed"

**Cause**: Key mismatch between API and expectations

**Fix**:
1. Ensure JWT_PUBLIC_KEY and JWT_PRIVATE_KEY are from the same key pair
2. Check keys aren't truncated (base64 encoding)
3. Regenerate keys if needed

### "DNS_PROBE_FINISHED_NXDOMAIN"

**Cause**: DNS not propagated or misconfigured

**Fix**:
1. Verify nameservers changed at registrar
2. Check DNS records in Cloudflare dashboard
3. Wait up to 24 hours for propagation
4. Test with: `dig +short api.YOUR_DOMAIN.com`

---

## Cost Estimation

### Platform Costs (Your Infrastructure)

| Component | Free Tier Limit | Paid Overage |
|-----------|-----------------|--------------|
| **Cloudflare Workers** | 100K requests/day | $0.15/million |
| **Cloudflare D1** | 5M rows read/day | $0.001/million |
| **Cloudflare KV** | 100K reads/day | $0.50/million |
| **Cloudflare R2** | 10GB storage | $0.015/GB/month |
| **Cloudflare Pages** | Unlimited | Free |

**Typical SAM deployment**: Stays within free tier for small to medium usage.

### User VM Costs (Paid by Users)

Users provide their own Hetzner API token. Workspace VMs are billed to their account:

| VM Size | Specs | Hourly | Monthly |
|---------|-------|--------|---------|
| **Small** (CX22) | 2 vCPU, 4GB RAM | €0.006 (~$0.007) | €3.79 (~$4.15) |
| **Medium** (CX32) | 4 vCPU, 8GB RAM | €0.011 (~$0.012) | €6.80 (~$7.50) |
| **Large** (CX42) | 8 vCPU, 16GB RAM | €0.027 (~$0.030) | €16.40 (~$18) |

VMs are billed hourly and self-terminate after 30 minutes of inactivity.

---

## Security Considerations

1. **Rotate Keys Regularly**: Generate new JWT and encryption keys quarterly
2. **Minimal GitHub App Permissions**: Only `Contents: Read-only` and `Metadata: Read-only`
3. **No Embedded Secrets**: Bootstrap tokens ensure no secrets in cloud-init
4. **HTTPS Only**: All traffic is encrypted via Cloudflare
5. **Session Security**: BetterAuth handles secure session management

---

## Getting Help

- **Issues**: [GitHub Issues](https://github.com/YOUR_ORG/simple-agent-manager/issues)
- **Documentation**: [docs/](../)
- **Architecture**: [Architecture Decision Records](../adr/)

---

*Last updated: February 2026*
