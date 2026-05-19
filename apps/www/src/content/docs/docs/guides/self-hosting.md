---
title: Self-Hosting Guide
description: Deploy SAM to your own infrastructure with Cloudflare Workers, Pulumi, and GitHub Actions.
---

This guide walks you through deploying Simple Agent Manager to your own infrastructure. Deployment is automated via GitHub Actions + Pulumi — push to `main` and everything is provisioned.

## Prerequisites

| Requirement              | Purpose                   | Tier          |
| ------------------------ | ------------------------- | ------------- |
| **Cloudflare account**   | API hosting, DNS, storage | Workers Paid ($5/mo) |
| **GitHub account**       | Authentication, CI/CD     | Free tier     |
| **Domain on Cloudflare** | Workspace URLs            | Any registrar |

**Workers Paid** is required because SAM uses Durable Objects for real-time chat, task execution, and node lifecycle. Go to **Workers & Pages** in the Cloudflare dashboard to upgrade. You also need **Analytics Engine** enabled (free): **Workers & Pages** → **Analytics Engine** → **Enable**.

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
| Account         | Containers             | Edit   |
| Zone            | DNS                    | Edit   |
| Zone            | Workers Routes         | Edit   |
| Zone            | SSL and Certificates   | Edit   |
| Zone            | Zone                   | Read   |

Set **Zone Resources** to your specific domain and **Account Resources** to your account.

:::caution[Use a top-level domain]
Use a top-level domain as `BASE_DOMAIN` (e.g., `example.com`), not a subdomain (`sam.example.com`). Cloudflare's free Universal SSL covers `*.example.com` but not nested wildcards like `*.sam.example.com`. The root domain is not used by SAM — only `api.`, `app.`, and `*.` subdomains are created.
:::

:::tip[DNSSEC]
If your registrar has DNSSEC enabled, disable it **before** changing nameservers to Cloudflare. DNSSEC with mismatched nameservers blocks DNS resolution.
:::

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

Base64 encode the private key:
```bash
cat your-key.pem | base64 -w0    # Linux
cat your-key.pem | base64        # macOS
```

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

The Workers Paid plan ($5/month) is required for Durable Objects. Beyond the base plan, usage-based costs stay within free tier allowances for small to medium usage.

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

### "OAuth callback failed" / redirect URI mismatch

Check that your GitHub App's Callback URL matches your `BASE_DOMAIN` exactly: `https://api.yourdomain.com/api/auth/callback/github`. If you changed `BASE_DOMAIN` after initial setup, update the URLs in both your GitHub OAuth App and GitHub App.

### Origin CA Certificate Error (1016)

Your API token is missing the **Zone → SSL and Certificates → Edit** permission. Edit the token in Cloudflare and add it.

### Analytics Engine Not Enabled (10089)

Go to **Workers & Pages** → **Analytics Engine** → **Enable**. This is free but must be explicitly activated.

### Durable Objects Free Plan Error (10097)

Upgrade to the **Workers Paid plan** ($5/month). Go to **Workers & Pages** → upgrade plan.

### Containers Forbidden

Your API token is missing the **Account → Containers → Edit** permission. Edit the token and add it.

### SSL Handshake Failure

If using a subdomain as `BASE_DOMAIN` (e.g., `sam.example.com`), the free Universal SSL certificate does not cover nested wildcards (`*.sam.example.com`). Use a top-level domain as `BASE_DOMAIN` instead.

### DNS Record Already Exists

If you changed `BASE_DOMAIN`, old DNS records from a previous deployment may conflict. Go to Cloudflare DNS and delete the stale `api`, `app`, and `*` records, then re-run the deploy.

### "D1_ERROR: no such table"

Migrations haven't been applied. The deploy workflow runs them automatically, but you can also run manually:

```bash
wrangler d1 migrations apply workspaces --remote
```

### "Workspace stuck in provisioning"

Check Hetzner console for VM status. If the VM is running, SSH in and check `systemctl status vm-agent`.

See the [full troubleshooting section](https://github.com/raphaeltm/simple-agent-manager/blob/main/docs/guides/self-hosting.md#troubleshooting) in the repository for more scenarios.
