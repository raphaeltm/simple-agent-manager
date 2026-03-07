---
title: Security Model
description: How SAM handles authentication, encryption, and credential management.
---

SAM's security model separates **platform secrets** (managed by operators) from **user credentials** (encrypted per-user in the database).

## Credential Types

### Platform Secrets

These are Cloudflare Worker secrets set during deployment:

| Secret | Purpose |
|--------|---------|
| `ENCRYPTION_KEY` | AES-256-GCM key for encrypting user credentials |
| `JWT_PRIVATE_KEY` | RSA-2048 key for signing workspace and callback tokens |
| `JWT_PUBLIC_KEY` | RSA-2048 key for token verification (exposed via JWKS) |
| `CF_API_TOKEN` | Cloudflare DNS and API access |
| `GITHUB_CLIENT_ID/SECRET` | OAuth authentication |
| `GITHUB_APP_*` | GitHub App for repository access |

Platform secrets are automatically generated and persisted by Pulumi on first deployment. They never appear in source control.

### User Credentials

User-provided secrets stored encrypted in D1:

| Credential | Purpose | Encryption |
|------------|---------|------------|
| Hetzner API token | VM provisioning | AES-256-GCM, per-credential IV |
| Agent API keys | Claude/OpenAI API access | AES-256-GCM, per-credential IV |
| Agent OAuth tokens | Claude Pro/Max subscriptions | AES-256-GCM, per-credential IV |

User credentials are **never** stored as environment variables or Worker secrets.

## Authentication Flow

SAM uses **BetterAuth** with GitHub OAuth for user authentication:

1. User clicks "Sign in with GitHub"
2. API redirects to GitHub OAuth
3. GitHub returns authorization code
4. API exchanges code for access token
5. API fetches user profile and primary email
6. BetterAuth creates/updates user record and session
7. Session cookie set in browser

### Token Types

| Token | Lifetime | Purpose | Validated By |
|-------|----------|---------|-------------|
| Session cookie | Hours | Browser authentication | API Worker (BetterAuth) |
| Workspace JWT | Minutes | Terminal WebSocket auth | VM Agent (via JWKS) |
| Bootstrap token | 5 minutes | One-time VM credential injection | API Worker |
| Callback token | Minutes | VM Agent → API callbacks | API Worker |

## Credential Encryption

User credentials are encrypted at rest using **AES-256-GCM**:

```
Encrypt: plaintext + ENCRYPTION_KEY → { ciphertext, iv }  (stored in D1)
Decrypt: { ciphertext, iv } + ENCRYPTION_KEY → plaintext   (on-demand)
```

Each credential gets a random initialization vector (IV), ensuring identical plaintext values produce different ciphertext.

## Terminal Authentication

Terminal WebSocket connections use short-lived JWTs:

1. Browser requests a terminal token: `POST /api/terminal/token`
2. API signs a JWT with the workspace ID and user ID
3. Browser connects: `wss://ws-{id}.domain/workspaces/{id}/shell?token=...`
4. Worker proxies the WebSocket to the VM Agent
5. VM Agent validates the JWT against the API's JWKS endpoint (`/.well-known/jwks.json`)

## Bootstrap Security

When a new VM starts, it needs credentials (callback URL, node ID) but **no secrets are embedded in cloud-init**:

1. API creates a one-time bootstrap token (cryptographically random, 5-minute expiry)
2. Cloud-init script includes only the token and API URL
3. VM Agent redeems the token: `POST /api/bootstrap/{token}`
4. API returns the full configuration (callback URL, node ID, etc.)
5. Token is invalidated after use

## Security Best Practices

- **Rotate keys quarterly** — regenerate JWT and encryption keys
- **Minimal GitHub App permissions** — only Contents (read/write), Metadata (read-only), and Email addresses (read-only)
- **HTTPS everywhere** — all traffic encrypted via Cloudflare
- **Session isolation** — each workspace JWT is scoped to a specific workspace ID
- **No shared cloud credentials** — BYOC model means the platform has no Hetzner access

:::caution
Rotating the `ENCRYPTION_KEY` will make existing encrypted credentials unreadable. Users will need to re-enter their Hetzner tokens and API keys after key rotation.
:::
