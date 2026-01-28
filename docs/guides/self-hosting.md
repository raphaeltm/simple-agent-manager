# Self-Hosting Guide

This guide covers deploying Simple Agent Manager to your own infrastructure.

## Infrastructure Requirements

### Cloudflare (Required)

Simple Agent Manager uses Cloudflare for:
- **Workers**: API hosting (serverless)
- **Pages**: Web UI hosting (static site)
- **D1**: SQLite database
- **KV**: Session storage
- **R2**: Binary storage (VM Agent)
- **DNS**: Workspace subdomain management

You'll need a Cloudflare account with a domain configured.

### Hetzner Cloud (Default VM Provider)

Workspaces run on Hetzner Cloud VMs. You can use:
- `cx22` (2 vCPU, 4GB RAM) - Small
- `cx32` (4 vCPU, 8GB RAM) - Medium (default)
- `cx42` (8 vCPU, 16GB RAM) - Large

Each user stores their own Hetzner API token, so VMs are billed to the user's account.

### GitHub (Authentication & Repository Access)

You'll need:
- **GitHub OAuth App**: For user authentication
- **GitHub App**: For repository access with fine-grained permissions

## Deployment Steps

### 1. Fork and Clone

```bash
git clone https://github.com/your-org/simple-agent-manager.git
cd simple-agent-manager
pnpm install
```

### 2. Create Cloudflare Resources

```bash
# Login to Cloudflare
wrangler login

# Create D1 database
wrangler d1 create simple-agent-manager

# Create KV namespace for sessions
wrangler kv:namespace create sessions

# Create R2 bucket for binaries
wrangler r2 bucket create simple-agent-manager
```

### 3. Configure Environment

Run the setup wizard:

```bash
pnpm setup
```

Or manually create `.env`:

```env
BASE_DOMAIN=workspaces.yourdomain.com
CF_API_TOKEN=your-cloudflare-api-token
CF_ZONE_ID=your-zone-id
GITHUB_CLIENT_ID=your-oauth-client-id
GITHUB_CLIENT_SECRET=your-oauth-client-secret
GITHUB_APP_ID=your-github-app-id
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----..."
```

### 4. Generate Security Keys

```bash
npx tsx scripts/generate-keys.ts --env >> .env
```

### 5. Update wrangler.toml

Edit `apps/api/wrangler.toml`:

```toml
name = "simple-agent-manager-api"

[[d1_databases]]
binding = "DATABASE"
database_name = "simple-agent-manager"
database_id = "your-database-id"

[[kv_namespaces]]
binding = "KV"
id = "your-kv-namespace-id"

[[r2_buckets]]
binding = "R2"
bucket_name = "simple-agent-manager"

[vars]
BASE_DOMAIN = "workspaces.yourdomain.com"
VERSION = "1.0.0"
```

### 6. Set Secrets

```bash
cd apps/api

# Core secrets
wrangler secret put CF_API_TOKEN
wrangler secret put CF_ZONE_ID
wrangler secret put GITHUB_CLIENT_ID
wrangler secret put GITHUB_CLIENT_SECRET
wrangler secret put GITHUB_APP_ID
wrangler secret put GITHUB_APP_PRIVATE_KEY
wrangler secret put ENCRYPTION_KEY
wrangler secret put JWT_PRIVATE_KEY
wrangler secret put JWT_PUBLIC_KEY
wrangler secret put JWT_KEY_ID
```

### 7. Deploy

```bash
# Deploy everything
pnpm deploy

# Or deploy individually
pnpm deploy:api
pnpm deploy:web
pnpm deploy:agent
```

### 8. Configure DNS

Add these DNS records in Cloudflare:

| Type | Name | Content |
|------|------|---------|
| CNAME | api | your-worker.workers.dev |
| CNAME | app | your-pages.pages.dev |
| A | ws-* | (managed by API) |

## GitHub App Setup

### Create GitHub App

1. Go to [GitHub Settings > Developer Settings > GitHub Apps](https://github.com/settings/apps)
2. Click "New GitHub App"
3. Configure:
   - **App name**: Simple Agent Manager
   - **Homepage URL**: `https://app.yourdomain.com`
   - **Callback URL**: `https://api.yourdomain.com/api/github/callback`
   - **Setup URL**: `https://app.yourdomain.com/settings`
   - **Webhook URL**: `https://api.yourdomain.com/api/github/webhook`
   - **Webhook secret**: Generate a random secret

### Required Permissions

| Permission | Access |
|------------|--------|
| Contents | Read-only |
| Metadata | Read-only |

### Generate Private Key

1. Scroll to "Private keys"
2. Click "Generate a private key"
3. Save the downloaded `.pem` file
4. Add to secrets:

```bash
cat path/to/key.pem | wrangler secret put GITHUB_APP_PRIVATE_KEY
```

## GitHub OAuth App Setup

For user authentication:

1. Go to [GitHub Settings > Developer Settings > OAuth Apps](https://github.com/settings/developers)
2. Click "New OAuth App"
3. Configure:
   - **Application name**: Simple Agent Manager Login
   - **Homepage URL**: `https://app.yourdomain.com`
   - **Authorization callback URL**: `https://api.yourdomain.com/api/auth/github/callback`

## Monitoring & Maintenance

### View Logs

```bash
wrangler tail
```

### Database Migrations

```bash
wrangler d1 migrations apply simple-agent-manager
```

### Update VM Agent

```bash
cd packages/vm-agent
make build-all
pnpm deploy:agent
```

## Security Considerations

1. **Rotate Keys Regularly**: Generate new JWT keys periodically
2. **Monitor Usage**: Watch for unusual workspace creation patterns
3. **Limit VM Sizes**: Consider restricting available VM sizes
4. **Enable Audit Logging**: Log all workspace operations
5. **Review GitHub App Permissions**: Keep permissions minimal

## Troubleshooting

### Workspace Creation Fails

1. Check Cloudflare DNS permissions
2. Verify Hetzner API token is valid
3. Check cloud-init logs on the VM

### Terminal Connection Issues

1. Verify JWT keys are correctly configured
2. Check JWKS endpoint is accessible
3. Verify VM Agent is running on the workspace

### Authentication Errors

1. Verify GitHub OAuth credentials
2. Check callback URLs are correct
3. Verify session KV namespace is accessible

## Cost Estimation

| Component | Cost |
|-----------|------|
| Cloudflare Workers | Free tier (100K requests/day) |
| Cloudflare Pages | Free tier |
| Cloudflare D1 | Free tier (5M rows) |
| Cloudflare R2 | Free tier (10GB storage) |
| Hetzner VMs | User-paid (varies by size) |

The platform itself runs on Cloudflare's free tier. Users pay for their own Hetzner VMs.
