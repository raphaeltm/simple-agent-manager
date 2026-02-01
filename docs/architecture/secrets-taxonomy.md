# Secrets Taxonomy

This document provides a complete classification of all secrets and credentials in Simple Agent Manager.

## Secret Categories

```
┌─────────────────────────────────────────────────────────────────┐
│                     SECRETS TAXONOMY                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────────────────┐    ┌─────────────────────────────┐ │
│  │   PLATFORM SECRETS      │    │   USER CREDENTIALS          │ │
│  │   (Worker Secrets)      │    │   (Encrypted in D1)         │ │
│  ├─────────────────────────┤    ├─────────────────────────────┤ │
│  │ • ENCRYPTION_KEY        │    │ • Hetzner API Token         │ │
│  │ • JWT_PRIVATE_KEY       │    │ • (Future cloud providers)  │ │
│  │ • JWT_PUBLIC_KEY        │    │                             │ │
│  │ • CF_API_TOKEN          │    │ Stored: Per-user in DB      │ │
│  │ • CF_ZONE_ID            │    │ Encrypted: AES-GCM          │ │
│  │ • GITHUB_CLIENT_ID      │    │ Provided: By each user      │ │
│  │ • GITHUB_CLIENT_SECRET  │    │                             │ │
│  │ • GITHUB_APP_ID         │    └─────────────────────────────┘ │
│  │ • GITHUB_APP_PRIVATE_KEY│                                    │
│  │                         │                                    │
│  │ Stored: Cloudflare      │                                    │
│  │ Set by: Platform admin  │                                    │
│  └─────────────────────────┘                                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Platform Secrets

These are configured once during deployment and apply to the entire platform.

### Required Platform Secrets

| Secret | Purpose | How to Generate |
|--------|---------|-----------------|
| `ENCRYPTION_KEY` | Encrypt user credentials in database | `openssl rand -base64 32` |
| `JWT_PRIVATE_KEY` | Sign JWT tokens for authentication | RSA-2048 PEM private key |
| `JWT_PUBLIC_KEY` | Verify JWT tokens | Corresponding RSA public key |
| `CF_API_TOKEN` | Create DNS records for workspaces | Cloudflare API token with DNS edit |
| `CF_ZONE_ID` | DNS zone for workspace subdomains | From Cloudflare dashboard |

### Optional Platform Secrets

| Secret | Purpose | When Needed |
|--------|---------|-------------|
| `GITHUB_CLIENT_ID` | OAuth authentication | For GitHub login |
| `GITHUB_CLIENT_SECRET` | OAuth authentication | For GitHub login |
| `GITHUB_APP_ID` | GitHub App integration | For repo access |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App authentication | For repo access |

### How Platform Secrets Are Set

```bash
# During deployment (via wrangler)
wrangler secret put ENCRYPTION_KEY --env production
wrangler secret put JWT_PRIVATE_KEY --env production
# ... etc

# Or via GitHub Actions workflow (deploy-setup.yml)
# Secrets are read from GitHub Secrets and pushed to Cloudflare
```

## User Credentials

These are provided by individual users through the application UI.

### Current User Credentials

| Credential | Purpose | Storage |
|------------|---------|---------|
| Hetzner API Token | Provision VMs for workspaces | `credentials` table, encrypted |

### How User Credentials Are Stored

```sql
-- Each user has their own encrypted credentials
INSERT INTO credentials (id, user_id, provider, encrypted_token, iv, ...)
VALUES ('cred_123', 'user_456', 'hetzner', '<encrypted>', '<iv>', ...);
```

### Access Pattern

```typescript
// ALWAYS filter by authenticated user
const credential = await db.query.credentials.findFirst({
  where: and(
    eq(credentials.userId, authenticatedUser.id),  // REQUIRED
    eq(credentials.provider, 'hetzner')
  )
});
```

## What Is NOT a Platform Secret

The following should **NEVER** be platform-level secrets:

| Credential | Why Not |
|------------|---------|
| Hetzner API Token | Users bring their own (BYOC model) |
| AWS/GCP credentials | Users bring their own |
| User passwords | We use OAuth, no passwords |

## Environment Variable Reference

### Development (.env.example)

```bash
# Port configuration
WRANGLER_PORT=8787

# GitHub OAuth (optional for local dev)
# GITHUB_CLIENT_ID=
# GITHUB_CLIENT_SECRET=

# Cloudflare (for DNS operations)
# CF_API_TOKEN=
# CF_ZONE_ID=

# Auto-generated if not provided
# ENCRYPTION_KEY=
# JWT_PRIVATE_KEY=
# JWT_PUBLIC_KEY=

# NOTE: Hetzner tokens are NOT here.
# Users provide their own through Settings UI.
```

### Production (Cloudflare Worker Secrets)

Set via `wrangler secret put` or deployment workflow:

- `ENCRYPTION_KEY` (required)
- `JWT_PRIVATE_KEY` (required)
- `JWT_PUBLIC_KEY` (required)
- `CF_API_TOKEN` (required)
- `CF_ZONE_ID` (required)
- `GITHUB_CLIENT_ID` (optional)
- `GITHUB_CLIENT_SECRET` (optional)
- `GITHUB_APP_ID` (optional)
- `GITHUB_APP_PRIVATE_KEY` (optional)

## Security Rules

### Do

- Store platform secrets in Cloudflare Worker Secrets
- Encrypt user credentials with AES-GCM before storing in D1
- Always filter user credentials by `user_id`
- Use unique IV for each encrypted credential
- Rotate keys when compromised

### Don't

- Put user credentials in environment variables
- Put user credentials in Worker Secrets
- Log decrypted credentials
- Share credentials between users
- Store Hetzner tokens at the platform level

## Related Documentation

- [Credential Security](./credential-security.md) - Encryption details
- [CLAUDE.md](../../CLAUDE.md) - Environment variable reference