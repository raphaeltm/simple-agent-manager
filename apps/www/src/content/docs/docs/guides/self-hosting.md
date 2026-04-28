---
title: Self-Hosting Guide
description: Deploy SAM to your own infrastructure with Cloudflare Workers, Pulumi, and GitHub Actions.
---

This guide walks you through deploying Simple Agent Manager to your own infrastructure. Deployment is automated via GitHub Actions + Pulumi — push to `main` and everything is provisioned.

## Prerequisites

| Requirement              | Purpose                   | Tier          |
| ------------------------ | ------------------------- | ------------- |
| **Cloudflare account**   | API hosting, DNS, storage | Free tier     |
| **GitHub account**       | Authentication, CI/CD     | Free tier     |
| **Domain on Cloudflare** | Workspace URLs            | Any registrar |

You do **not** need a shared cloud provider account. Users provide their own [Hetzner API token](https://console.hetzner.cloud/) or [Scaleway API key](https://console.scaleway.com/iam/api-keys) through the Settings UI.

## Step 1: Fork the Repository

Fork [simple-agent-manager](https://github.com/raphaeltm/simple-agent-manager) on GitHub.

## Step 2: Create Cloudflare API Token

In Cloudflare Dashboard → My Profile → API Tokens → Create Custom Token:

| Permission Type | Resource               | Access |
| --------------- | ---------------------- | ------ |
| Account         | Cloudflare Workers: D1 | Edit   |
| Account         | Workers KV Storage     | Edit   |
| Account         | Workers R2 Storage     | Edit   |
| Account         | Workers Scripts        | Edit   |
| Account         | Workers Observability  | Read   |
| Account         | Cloudflare Pages       | Edit   |
| Account         | AI Gateway             | Edit   |
| Zone            | DNS                    | Edit   |
| Zone            | Workers Routes         | Edit   |
| Zone            | SSL and Certificates   | Edit   |
| Zone            | Zone                   | Read   |

Set **Zone Resources** to your specific domain and **Account Resources** to your account.

## Step 3: Create GitHub App

Go to [GitHub App Settings](https://github.com/settings/apps) → New GitHub App:

**Basic settings:**

- Homepage URL: `https://app.yourdomain.com`
- Callback URL: `https://api.yourdomain.com/api/auth/callback/github`
- Setup URL: `https://api.yourdomain.com/api/github/callback`

**Permissions:**

- Repository → Contents: Read and write
- Repository → Metadata: Read-only
- Account → Email addresses: Read-only

**Webhook:**

- URL: `https://api.yourdomain.com/api/github/webhook`
- Active: checked
- Secret: generate a random string and save the same value as the `GH_WEBHOOK_SECRET` GitHub Environment secret

After creation, note the **App ID** and **Client ID**, generate a **Client Secret** and **Private Key**.

:::caution
"Request user authorization (OAuth) during installation" must be **unchecked**. When checked, it disables the Setup URL and breaks post-installation redirects.
:::

## Step 4: Create R2 API Token

Separate from the main API token, this is for Pulumi state storage:

1. Cloudflare Dashboard → R2 → Manage R2 API Tokens
2. Create token with **Object Read & Write** permissions
3. Note the Access Key ID and Secret Access Key

## Step 5: Generate Pulumi Passphrase

```bash
openssl rand -base64 32
```

Save this passphrase — you'll need it for all future deployments.

## Step 6: Configure GitHub Environment

In your fork: Settings → Environments → New environment → name it `production`.

**Environment variables:**

| Variable          | Description                           | Example       |
| ----------------- | ------------------------------------- | ------------- |
| `BASE_DOMAIN`     | Your domain                           | `example.com` |
| `RESOURCE_PREFIX` | Cloudflare resource prefix (optional) | `sam`         |

**Environment secrets:**

| Secret                     | Description                                                                    |
| -------------------------- | ------------------------------------------------------------------------------ |
| `CF_API_TOKEN`             | Cloudflare API token                                                           |
| `CF_ACCOUNT_ID`            | Cloudflare account ID (32-char hex)                                            |
| `CF_ZONE_ID`               | Domain zone ID (32-char hex)                                                   |
| `R2_ACCESS_KEY_ID`         | R2 API token access key                                                        |
| `R2_SECRET_ACCESS_KEY`     | R2 API token secret key                                                        |
| `PULUMI_CONFIG_PASSPHRASE` | Generated passphrase                                                           |
| `GH_CLIENT_ID`             | GitHub App client ID                                                           |
| `GH_CLIENT_SECRET`         | GitHub App client secret                                                       |
| `GH_APP_ID`                | GitHub App ID                                                                  |
| `GH_APP_PRIVATE_KEY`       | GitHub App private key (PEM or base64)                                         |
| `GH_APP_SLUG`              | GitHub App URL slug                                                            |
| `GH_WEBHOOK_SECRET`        | GitHub App webhook secret; mapped to the Worker secret `GITHUB_WEBHOOK_SECRET` |

:::note
GitHub App secrets use `GH_*` prefix because GitHub Actions secret names cannot start with `GITHUB_*`. The deployment workflow maps those `GH_*` secrets to `GITHUB_*` Worker secrets. `GH_WEBHOOK_SECRET` becomes the Worker secret `GITHUB_WEBHOOK_SECRET` and must match the GitHub App webhook secret.
:::

:::note
Security keys (`ENCRYPTION_KEY`, `JWT_PRIVATE_KEY`, `JWT_PUBLIC_KEY`), Origin CA credentials (`ORIGIN_CA_CERT`, `ORIGIN_CA_KEY`), and `TRIAL_CLAIM_TOKEN_SECRET` are automatically generated and persisted via Pulumi. No manual setup required.
:::

## Step 7: Deploy

Push any commit to `main`, or go to Actions → Deploy → Run workflow.

The workflow:

1. Validates configuration
2. Provisions infrastructure via Pulumi (D1, KV, R2, DNS)
3. Deploys API Worker and Web UI
4. Runs database migrations
5. Builds and uploads VM Agent binaries
6. Runs health check

## Verification

After deployment completes:

```bash
# API health check
curl https://api.yourdomain.com/health
# Should return: {"status":"healthy","timestamp":"..."}
```

Open `https://app.yourdomain.com` — you should see the login page.

## Teardown

To remove all resources: Actions → Teardown → Run workflow → type `DELETE` to confirm.

## Cost Estimation

### Platform Costs

| Component          | Free Tier        | Paid Overage    |
| ------------------ | ---------------- | --------------- |
| Cloudflare Workers | 100K req/day     | $0.15/million   |
| Cloudflare D1      | 5M rows read/day | $0.001/million  |
| Cloudflare KV      | 100K reads/day   | $0.50/million   |
| Cloudflare R2      | 10GB storage     | $0.015/GB/month |
| Cloudflare Pages   | Unlimited        | Free            |

A typical SAM deployment stays within the free tier for small to medium usage.

### User VM Costs

VMs are billed to each user's own cloud provider account. SAM supports Hetzner, Scaleway, and GCP.

**Hetzner:**

| Size          | Specs            | Hourly  | Monthly |
| ------------- | ---------------- | ------- | ------- |
| Small (cx23)  | 2 vCPU, 4GB RAM  | ~$0.007 | ~$4.15  |
| Medium (cx33) | 4 vCPU, 8GB RAM  | ~$0.012 | ~$7.50  |
| Large (cx43)  | 8 vCPU, 16GB RAM | ~$0.030 | ~$18    |

**Scaleway:**

| Size             | Type             | Hourly  |
| ---------------- | ---------------- | ------- |
| Small (DEV1-M)   | 3 vCPU, 4GB RAM  | ~€0.024 |
| Medium (DEV1-XL) | 4 vCPU, 12GB RAM | ~€0.048 |
| Large (GP1-S)    | 8 vCPU, 32GB RAM | ~€0.084 |

## Troubleshooting

### "error: failed to decrypt state"

Your `PULUMI_CONFIG_PASSPHRASE` doesn't match the one used when state was created. Use the original passphrase or delete the stack in R2 and start fresh.

### "OAuth callback failed"

Check that your GitHub App's Callback URL matches exactly: `https://api.yourdomain.com/api/auth/callback/github`

### "D1_ERROR: no such table"

Migrations haven't been applied. The deploy workflow runs them automatically, but you can also run manually:

```bash
wrangler d1 migrations apply workspaces --remote
```

### "Workspace stuck in provisioning"

Check Hetzner console for VM status. If the VM is running, SSH in and check `systemctl status vm-agent`.

See the [full troubleshooting section](https://github.com/raphaeltm/simple-agent-manager/blob/main/docs/guides/self-hosting.md#troubleshooting) in the repository for more scenarios.
