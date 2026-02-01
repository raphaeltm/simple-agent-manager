# Quickstart: Self-Hosting Simple Agent Manager

**Feature**: 005-automated-deployment | **Deployment Time**: ~10 minutes

## Overview

Deploy your own Simple Agent Manager instance using GitHub Actions. **Deployment is automatic on every push to main.** This guide covers the one-time setup process using Pulumi for infrastructure and Wrangler for application deployment.

## Prerequisites

**Cloudflare Account** (free tier works):
- Account at [cloudflare.com](https://cloudflare.com)
- Domain added to Cloudflare with nameservers configured
- API token with required permissions

**GitHub Repository**:
- Fork of the Simple Agent Manager repository
- Access to repository Environments configuration

## One-Time Setup (Manual Steps)

These steps are done once when setting up your deployment environment.

### Step 1: Create R2 API Token

Pulumi needs S3-compatible credentials to access the state bucket (the bucket itself is created automatically by the workflow).

1. Go to **Cloudflare Dashboard** → **R2** → **Manage R2 API tokens**
2. Click **Create API token**
3. Permissions: **Object Read & Write**
4. Specify bucket: **All buckets** (or leave empty to allow bucket creation)
5. Click **Create API Token**
6. **Save both values**:
   - Access Key ID (starts with a long alphanumeric string)
   - Secret Access Key (shown only once)

### Step 2: Create Cloudflare API Token

Create a token with permissions for all Cloudflare resources.

1. Go to **Cloudflare Dashboard** → **My Profile** → **API Tokens**
2. Click **Create Token** → **Custom token**
3. Add these permissions:

| Permission | Access |
|------------|--------|
| Account - D1 | Edit |
| Account - Workers KV Storage | Edit |
| Account - Workers R2 Storage | Edit |
| Account - Workers Scripts | Edit |
| Account - Cloudflare Pages | Edit |
| Zone - DNS | Edit |
| Zone - Zone | Read |

4. Zone Resources: Include your domain's zone
5. Click **Create Token** and save it

### Step 3: Generate Pulumi Passphrase

Create a strong passphrase for encrypting secrets in Pulumi state:

```bash
# Generate a random passphrase
openssl rand -base64 32
```

**Important**: Save this passphrase securely (password manager recommended). If lost, you cannot decrypt existing state and must recreate infrastructure.

### Step 4: Create GitHub Environment

Configuration lives in a **GitHub Environment** (not repository secrets). This makes configuration visible and editable in the GitHub UI.

1. Go to **Settings** → **Environments**
2. Click **New environment**
3. Name it `production` and click **Configure environment**

### Step 5: Configure Environment Variables

Add these **Environment variables** (visible in UI):

| Variable | Description | Example |
|----------|-------------|---------|
| `BASE_DOMAIN` | Your base domain | `example.com` |
| `RESOURCE_PREFIX` | Resource naming prefix (optional) | `sam` |
| `PULUMI_STATE_BUCKET` | State bucket name (optional) | `sam-pulumi-state` |

### Step 6: Configure Environment Secrets

Add these **Environment secrets**:

| Secret Name | Value |
|-------------|-------|
| `CF_API_TOKEN` | Your Cloudflare API token |
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

**Where to find Cloudflare IDs**:
- Account ID: Cloudflare Dashboard sidebar (right side)
- Zone ID: Domain overview page (right sidebar)

---

## Deployment

### Automatic Deployment

**Every push to `main` automatically triggers deployment.** You can also trigger manually.

### First Deployment

1. Ensure the GitHub Environment is fully configured (Steps 4-6)
2. Push any commit to `main`, OR
3. Go to **Actions** → **"Deploy"** → **"Run workflow"** for manual trigger

The workflow will:
1. ✅ Validate all required configuration exists
2. ✅ Provision infrastructure via Pulumi (D1, KV, R2, DNS)
3. ✅ Sync configuration to wrangler.toml
4. ✅ Generate security keys (if not already configured)
5. ✅ Deploy API Worker via Wrangler
6. ✅ Deploy Web UI to Cloudflare Pages
7. ✅ Run database migrations
8. ✅ Configure Worker secrets
9. ✅ Build and upload VM Agent binaries
10. ✅ Validate deployment health

### Deployment Output

After successful deployment, check the workflow summary for:

```
✅ Deployment Complete

API URL: https://api.example.com
App URL: https://app.example.com

Pulumi Stack: prod
Resources Created: D1, KV, R2, DNS records
```

### Verify Deployment

Visit your App URL to verify the deployment works. You should see the Simple Agent Manager login page.

---

## Updating Your Deployment

**Deployment is automatic.** Just push or merge to `main`:

1. Make your changes
2. Push to `main` (or merge a PR)
3. The Deploy workflow runs automatically

Pulumi handles updates idempotently - only changed resources are updated.

---

## Teardown

To remove all deployed resources:

1. Go to **Actions** → **"Teardown"** workflow
2. Click **"Run workflow"**
3. Type `DELETE` to confirm
4. Click **"Run workflow"**

**Note**: The state bucket (`sam-pulumi-state`) is NOT deleted. Delete it manually if no longer needed.

### Teardown Options

- **Full teardown**: Removes all resources including data
- **Keep data** (checkbox): Preserves D1 database for potential recovery

---

## GitHub App Setup (Required)

SAM requires a GitHub OAuth App (for login) and a GitHub App (for repository access).

### Create GitHub OAuth App

1. Go to **GitHub Settings** → **Developer settings** → **OAuth Apps**
2. Click **"New OAuth App"**
3. Configure:
   - **Application name**: `Simple Agent Manager`
   - **Homepage URL**: `https://app.YOUR_DOMAIN.com`
   - **Authorization callback URL**: `https://api.YOUR_DOMAIN.com/api/auth/callback/github`
4. Click **Register application**
5. Note the **Client ID**
6. Click **Generate a new client secret** and save it

### Create GitHub App

1. Go to **GitHub Settings** → **Developer settings** → **GitHub Apps**
2. Click **"New GitHub App"**
3. Configure:
   - **Name**: `Simple Agent Manager - YourOrg`
   - **Homepage URL**: `https://app.YOUR_DOMAIN.com`
   - **Callback URL**: `https://api.YOUR_DOMAIN.com/api/github/callback`
   - **Webhook URL**: `https://api.YOUR_DOMAIN.com/api/github/webhook`
   - **Repository permissions**: Contents (Read-only), Metadata (Read-only)
4. Create the app and note:
   - **App ID** (number at top of page)
   - **App slug** (the URL-friendly name, e.g., `simple-agent-manager-yourorg`)
5. Generate a **Private Key** (downloads .pem file)
6. Base64 encode the private key:
   ```bash
   cat your-key.pem | base64 -w0
   ```

Add all these values to your GitHub Environment secrets (see Step 6 above).

---

## Troubleshooting

### Pulumi Login Failed

**Error**: `error: could not load backend state`

**Solution**: Verify R2 credentials:
- Check `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` are correct
- Verify the state bucket exists
- Ensure R2 token has Object Read & Write permissions

### Passphrase Mismatch

**Error**: `error: failed to decrypt secrets`

**Solution**: The `PULUMI_CONFIG_PASSPHRASE` doesn't match the one used previously. If you've lost it, you'll need to:
1. Delete the state bucket contents (or create new bucket)
2. Re-run deployment (creates fresh infrastructure)

### DNS Not Resolving

DNS propagation can take up to 24 hours. Check status:

```bash
dig api.example.com
dig app.example.com
```

### Permission Denied

**Error**: `error: Cloudflare API error`

**Solution**: Verify your CF_API_TOKEN has all required permissions listed in Step 3.

### Resource Already Exists

Pulumi tracks state and handles existing resources. If you see conflicts:
1. Check if resources were created manually in Cloudflare dashboard
2. Import existing resources: `pulumi import ...`
3. Or delete conflicting resources and re-run

---

## Configuration Reference

### Environment Variables (Visible)

| Variable | Required | Description |
|----------|----------|-------------|
| `BASE_DOMAIN` | Yes | Your base domain (e.g., `example.com`) |
| `RESOURCE_PREFIX` | No | Prefix for resources (default: `sam`) |
| `PULUMI_STATE_BUCKET` | No | State bucket name (default: `sam-pulumi-state`) |

### Required Secrets

| Secret | Description |
|--------|-------------|
| `CF_API_TOKEN` | Cloudflare API token with full permissions |
| `CF_ACCOUNT_ID` | 32-character Cloudflare account ID |
| `CF_ZONE_ID` | 32-character zone ID for your domain |
| `R2_ACCESS_KEY_ID` | R2 S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | R2 S3-compatible secret key |
| `PULUMI_CONFIG_PASSPHRASE` | Passphrase for state encryption |
| `GH_CLIENT_ID` | GitHub OAuth App client ID |
| `GH_CLIENT_SECRET` | GitHub OAuth App client secret |
| `GH_APP_ID` | GitHub App ID |
| `GH_APP_PRIVATE_KEY` | GitHub App private key (base64 encoded) |
| `GH_APP_SLUG` | GitHub App slug (URL name) |

### Auto-Generated Secrets

These security keys are **automatically generated** on first deployment and stored in Cloudflare Worker secrets:

| Secret | Description |
|--------|-------------|
| `ENCRYPTION_KEY` | AES-256 key for encrypting stored credentials |
| `JWT_PRIVATE_KEY` | RSA-2048 private key for signing terminal tokens |
| `JWT_PUBLIC_KEY` | RSA-2048 public key for token verification |

You do not need to add these to GitHub Secrets. For persistence across fresh deployments, copy them from Cloudflare Worker secrets to GitHub Secrets after first deployment.

### Resources Created

| Resource | Name Pattern | Purpose |
|----------|--------------|---------|
| D1 Database | `sam-prod` | Workspace metadata |
| KV Namespace | `sam-prod-sessions` | Sessions, tokens |
| R2 Bucket | `sam-prod-assets` | VM Agent binaries |
| DNS (API) | `api.{domain}` | API endpoint |
| DNS (App) | `app.{domain}` | Web UI |
| DNS (Wildcard) | `*.{domain}` | Workspace routing |

---

## Next Steps

After successful deployment:

1. **Sign in** with GitHub OAuth
2. **Connect Hetzner** (Settings → Cloud Providers) for VM provisioning
3. **Create a workspace** from a Git repository
4. **Monitor usage** in Cloudflare dashboard

Need help? Check the [deployment troubleshooting guide](../../docs/guides/deployment-troubleshooting.md) or open a GitHub issue.
