# Google Cloud (GCP) Setup Guide

This guide walks you through connecting Google Cloud Platform to Simple Agent Manager (SAM) so you can provision Compute Engine VMs for workspaces.

SAM uses **OIDC federation** (Workload Identity Federation) — no long-lived service account keys are stored. Instead, SAM issues short-lived identity tokens that GCP exchanges for temporary access tokens.

---

## Prerequisites

- A Google Cloud project with billing enabled
- A domain configured with SAM (see [Self-Hosting Guide](./self-hosting.md))
- Platform admin access to set Worker secrets

---

## Step 1: Create Google OAuth 2.0 Credentials

SAM uses Google OAuth to authenticate you and access GCP APIs on your behalf during setup.

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create a new one)
3. Navigate to **APIs & Services > Credentials**
4. Click **Create Credentials > OAuth 2.0 Client ID**
5. Select **Web application** as the application type
6. Set a name (e.g., "SAM OAuth Client")
7. Under **Authorized redirect URIs**, add:
   ```
   https://api.<YOUR_BASE_DOMAIN>/api/deployment/gcp/callback
   ```
   Replace `<YOUR_BASE_DOMAIN>` with your SAM domain (e.g., `example.com`).

   This is a single static URI shared by all projects — no per-project URIs are needed.

8. Click **Create** and note the **Client ID** and **Client Secret**

### Configure OAuth Secrets

Set these as Cloudflare Worker secrets (or GitHub Environment secrets for automated deployment):

| Secret | Value |
|--------|-------|
| `GOOGLE_CLIENT_ID` | Your OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Your OAuth 2.0 Client Secret |

```bash
# Via wrangler (manual)
wrangler secret put GOOGLE_CLIENT_ID --env production
wrangler secret put GOOGLE_CLIENT_SECRET --env production

# Via GitHub Environment (automated deployment)
# Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET as secrets
# in your GitHub Environment named "production"
```

> **Note**: Unlike GitHub secrets (which use the `GH_` → `GITHUB_` prefix mapping), Google OAuth secrets use the `GOOGLE_*` prefix directly — no mapping is needed.

---

## Step 2: Connect Google Cloud in SAM

Once the OAuth secrets are configured and deployed:

1. Log into SAM at `https://app.<YOUR_BASE_DOMAIN>`
2. Go to **Settings > Cloud Providers** (or click "Cloud Providers" in any project's settings drawer)
3. Under **Google Cloud**, click **Connect Google Cloud**
4. You'll be redirected to Google's OAuth consent screen
5. Grant the requested permissions
6. Select the GCP project you want to connect
7. Choose a default zone for VMs
8. Click **Connect Google Cloud** to complete setup

SAM will automatically:
- Get your GCP project number
- Enable the required APIs (Compute Engine, IAM)
- Create a Workload Identity Federation (WIF) pool and OIDC provider
- Create a service account with the necessary permissions
- Verify the OIDC token exchange works end-to-end

---

## How OIDC Federation Works

Traditional cloud authentication uses long-lived API keys or service account JSON keys. SAM uses a more secure approach:

```
SAM Platform                    Google Cloud
┌──────────────┐               ┌──────────────────────┐
│ Signs a JWT  │               │ Workload Identity    │
│ (short-lived,│──────────────>│ Federation Pool      │
│  project-    │  STS Token    │                      │
│  scoped)     │  Exchange     │ Validates JWT issuer │
│              │               │ & audience           │
│              │<──────────────│                      │
│              │  Federated    │ Returns federated    │
│              │  Token        │ access token         │
│              │               │                      │
│              │──────────────>│ Service Account      │
│              │  SA Imperso-  │ Impersonation        │
│              │  nation       │                      │
│              │<──────────────│ Returns SA access    │
│              │  SA Token     │ token (1hr TTL)      │
└──────────────┘               └──────────────────────┘
```

1. **SAM signs a JWT** — a short-lived token (10 min) scoped to the specific user and project
2. **GCP STS validates the JWT** — checks the issuer matches your SAM deployment and the audience matches the WIF pool
3. **Federated token is exchanged** — for a service account access token via impersonation
4. **SA token is cached** — in Cloudflare KV for up to 55 minutes to reduce API calls

This means:
- No long-lived credentials are stored in SAM's database
- Tokens are automatically rotated
- Access can be revoked by deleting the WIF pool or service account in GCP

---

## Service Account Permissions

The service account created by SAM's automated setup has these roles:

| Role | Purpose |
|------|---------|
| `roles/compute.admin` | Create, manage, and delete Compute Engine VMs |
| `roles/aiplatform.user` | Access AI Platform APIs (for Workers AI integration) |

The service account also has `roles/iam.workloadIdentityUser` on itself, allowing the WIF pool to impersonate it.

---

## Configuration Reference

### Required Secrets

| Secret | Description |
|--------|-------------|
| `GOOGLE_CLIENT_ID` | Google OAuth 2.0 Client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth 2.0 Client Secret |

### Optional Environment Variables

These have sensible defaults — override only if needed:

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_WIF_POOL_ID` | `sam-pool` | WIF pool ID for VM provisioning |
| `GCP_WIF_PROVIDER_ID` | `sam-oidc` | OIDC provider ID within the pool |
| `GCP_SERVICE_ACCOUNT_ID` | `sam-vm-manager` | Service account for VM operations |
| `GCP_IDENTITY_TOKEN_EXPIRY_SECONDS` | `600` | SAM-issued identity token lifetime (10 min) |
| `GCP_TOKEN_CACHE_TTL_SECONDS` | `3300` | Access token cache TTL in KV (55 min) |
| `GCP_API_TIMEOUT_MS` | `30000` | Timeout for GCP API calls |
| `GCP_SA_TOKEN_LIFETIME_SECONDS` | `3600` | SA access token lifetime (1 hour) |
| `GCP_STS_SCOPE` | `https://www.googleapis.com/auth/cloud-platform` | OAuth scope for STS token exchange |
| `GCP_SA_IMPERSONATION_SCOPES` | `https://www.googleapis.com/auth/compute` | Comma-separated scopes for SA impersonation |
| `GCP_DEFAULT_ZONE` | `us-central1-a` | Default Compute Engine zone |
| `GCP_IMAGE_FAMILY` | `ubuntu-2404-lts-amd64` | VM image family |
| `GCP_IMAGE_PROJECT` | `ubuntu-os-cloud` | VM image project |
| `GCP_DISK_SIZE_GB` | `50` | Default disk size in GB |

### GCP Deployment Variables (for Defang project deployment)

These are separate from VM provisioning — they control project-level deployment via GCP:

| Variable | Default | Description |
|----------|---------|-------------|
| `GCP_DEPLOY_WIF_POOL_ID` | `sam-deploy-pool` | WIF pool for deployment auth |
| `GCP_DEPLOY_WIF_PROVIDER_ID` | `sam-oidc` | OIDC provider for deployment |
| `GCP_DEPLOY_SERVICE_ACCOUNT_ID` | `sam-deployer` | SA for deployment operations |
| `GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS` | `600` | Deploy identity token lifetime |

---

## Troubleshooting

### "Connect Google Cloud" button doesn't appear

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are set as Worker secrets
- Redeploy after setting secrets (secrets require a new deployment to take effect)

### OAuth redirect fails

- Check the redirect URI matches exactly: `https://api.<YOUR_BASE_DOMAIN>/api/deployment/gcp/callback`
- Verify DNS is configured for `api.<YOUR_BASE_DOMAIN>`
- Check Google Console for any error messages on the OAuth consent screen

### "GCP STS token exchange failed"

- The WIF pool or OIDC provider may not exist — try disconnecting and reconnecting
- Check that the SAM API's issuer URL (`https://api.<YOUR_BASE_DOMAIN>`) matches the OIDC provider configuration in GCP
- Verify the GCP project has billing enabled and required APIs are active

### "GCP SA impersonation failed"

- The service account may lack the `roles/iam.workloadIdentityUser` role
- Check that the service account email matches the one stored in SAM
- Verify the WIF pool has the correct attribute mapping

### Token exchange succeeds but VM creation fails

- Check the service account has `roles/compute.admin` on the GCP project
- Verify the selected zone has available quota for the requested VM size
- Check Compute Engine API is enabled in the GCP project

### Disconnecting and reconnecting

To start fresh:
1. Go to **Settings > Cloud Providers**
2. Click **Disconnect** under Google Cloud
3. Optionally, clean up in GCP Console:
   - Delete the WIF pool: **IAM & Admin > Workload Identity Federation**
   - Delete the service account: **IAM & Admin > Service Accounts**
4. Click **Connect Google Cloud** to set up again

---

## Related Documentation

- [Self-Hosting Guide](./self-hosting.md) — full deployment instructions
- [Secrets Taxonomy](../architecture/secrets-taxonomy.md) — all platform secrets and user credentials
- [Credential Security](../architecture/credential-security.md) — encryption details
