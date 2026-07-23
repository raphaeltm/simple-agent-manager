---
title: Security Model
description: How SAM handles authentication, encryption, and credential management.
---

SAM's security model separates **platform secrets** (managed by operators) from **user credentials** (encrypted per-user in the database).

## Cloud Credential Model (BYOC + Platform Fallback)

SAM supports **Bring-Your-Own-Cloud (BYOC)**: users and self-hosters may store their own Hetzner, Scaleway, Vultr, or GCP credentials, encrypted per-user in D1. This is the model for self-hosted deployments and BYO-key users.

However, SAM's own hosted deployment also has an **enabled platform-level cloud credential** (`platform_credentials`, `provider=hetzner`, `credential_type=cloud-provider`). Provider resolution falls back **user credential → platform credential**, so on the hosted (zero-config) platform a user does **not** need their own cloud credential for SAM to provision workspaces or deployment nodes. Self-hosted deployments without a platform credential rely on user-supplied BYOC tokens.

## Credential Types

### Platform Secrets

These are Cloudflare Worker secrets set during deployment:

| Secret                       | Purpose                                                                                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ENCRYPTION_KEY`             | AES-256-GCM master key for BetterAuth sessions and user credential encryption                                                                     |
| `BETTER_AUTH_SECRET`         | Optional override for BetterAuth session cookies (falls back to `ENCRYPTION_KEY`)                                                                 |
| `CREDENTIAL_ENCRYPTION_KEY`  | Optional override for user credential encryption (falls back to `ENCRYPTION_KEY`)                                                                 |
| `JWT_PRIVATE_KEY`            | RSA-2048 key for signing workspace and callback tokens                                                                                            |
| `JWT_PUBLIC_KEY`             | RSA-2048 key for token verification (exposed via JWKS)                                                                                            |
| `DEPLOY_SIGNING_PRIVATE_KEY` | Ed25519 key for signing deployment apply payloads (auto-generated)                                                                                |
| `DEPLOY_SIGNING_PUBLIC_KEY`  | Ed25519 key for deployment-node payload verification (auto-generated)                                                                             |
| `TRIAL_CLAIM_TOKEN_SECRET`   | HMAC secret for trial onboarding claim tokens (auto-generated)                                                                                    |
| `CF_API_TOKEN`               | Cloudflare deploy, DNS, Origin CA certificate issuance, observability, and AI Gateway operations (requires Account → SSL and Certificates → Edit) |

Security keys are automatically generated and persisted by Pulumi on first deployment. Cloudflare secrets remain Worker secrets because they are deployment trust roots. GitHub App/OAuth, GitHub webhook, Google OAuth, and GitLab OAuth credentials can be supplied either as optional environment fallbacks or through the first-run/superadmin platform config UI; runtime values are stored encrypted in D1 and override environment fallbacks. They never appear in source control.

### Platform Integration Credentials

Admin-managed integration secrets stored encrypted in D1:

| Credential                       | Purpose                                                    | Resolution order                                               |
| -------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------- |
| GitHub OAuth client secret       | GitHub sign-in and OAuth refresh                           | Runtime D1 → Worker env → unset                                |
| GitHub App private key           | Installation tokens for repository access                  | Runtime D1 → Worker env → unset                                |
| GitHub webhook secret            | GitHub App webhook HMAC verification                       | Runtime D1 → Worker env → unset                                |
| Google login OAuth client secret | Google sign-in (BetterAuth social login)                   | Runtime D1 → Worker env (`GOOGLE_LOGIN_CLIENT_SECRET`) → unset |
| GitLab OAuth client secret       | GitLab sign-in and repository access                       | Runtime D1 → Worker env (`GITLAB_CLIENT_SECRET`) → unset       |
| Google infra OAuth client secret | Keyless GCP/WIF authorization (separate client from login) | Runtime D1 → Worker env (`GOOGLE_CLIENT_SECRET`) → unset       |

### User Credentials

User-provided secrets stored encrypted in D1:

| Credential                      | Purpose                                                                     | Encryption                     |
| ------------------------------- | --------------------------------------------------------------------------- | ------------------------------ |
| Cloud provider credentials      | VM provisioning (Hetzner, Scaleway, Vultr, GCP WIF or service-account JSON)        | AES-256-GCM, per-credential IV |
| Agent API keys                  | Claude, OpenAI, Gemini, and other agent access                              | AES-256-GCM, per-credential IV |
| Agent OAuth tokens              | Claude Pro/Max, Codex subscriptions                                         | AES-256-GCM, per-credential IV |
| Composable credentials (`cc_*`) | Reusable credential + configuration attachments layered per project/profile | AES-256-GCM, per-credential IV |

Cloud provider credentials are stored with a `credentialType` of `cloud-provider`. GCP can use recommended keyless WIF or an OAuth-free service-account JSON key for VM provisioning. User credentials are **never** stored as environment variables or Worker secrets.

## Authentication Flow

SAM uses **BetterAuth** with configured OAuth login providers for user authentication:

1. User clicks a configured sign-in provider such as GitHub, Google, or GitLab
2. API redirects to that provider's OAuth flow
3. The provider returns an authorization code
4. API exchanges code for access token
5. API fetches user profile and email
6. BetterAuth creates/updates user record and session
7. Session cookie set in browser

### Token Types

| Token           | Lifetime  | Purpose                          | Validated By            |
| --------------- | --------- | -------------------------------- | ----------------------- |
| Session cookie  | Hours     | Browser authentication           | API Worker (BetterAuth) |
| Workspace JWT   | Minutes   | Terminal WebSocket auth          | VM Agent (via JWKS)     |
| Bootstrap token | 5 minutes | One-time VM credential injection | API Worker              |
| Callback token  | Minutes   | VM Agent → API callbacks         | API Worker              |

## Credential Encryption

User credentials are encrypted at rest using **AES-256-GCM**:

```
Encrypt: plaintext + ENCRYPTION_KEY → { ciphertext, iv }  (stored in D1)
Decrypt: { ciphertext, iv } + ENCRYPTION_KEY → plaintext   (on-demand)
```

Each credential gets a random initialization vector (IV), ensuring identical plaintext values produce different ciphertext.

### GCP credential handling

GCP WIF configuration and uploaded service-account JSON use the same versioned credential boundary. Existing unversioned WIF records are normalized when read. Service-account JSON is validated as a Google `service_account` key with an importable PKCS#8 RSA private key; uploaded `token_uri` and other endpoint fields are ignored.

The complete source credential is encrypted at rest with AES-256-GCM. SAM signs short-lived RS256 assertions and exchanges them only at the fixed Google OAuth token endpoint. Derived Google access tokens are cached in KV only until their returned expiry minus a safety buffer; they are never persisted as primary credentials. Cache identity includes the authentication mode and WIF or private-key identity, so switching modes or rotating a key cannot reuse a prior token.

Save and rotation verify the selected Compute zone before a D1 transaction replaces both legacy and composable credential copies. A failed verification or transaction leaves the previous credential intact. Disconnect removes SAM's encrypted copies and cached derivatives but does not revoke a Google-managed service-account key.

## Terminal Authentication

Terminal WebSocket connections use short-lived JWTs:

1. Browser requests a terminal token: `POST /api/terminal/token`
2. API signs a JWT with the workspace ID and user ID
3. Browser connects: `wss://ws-{id}.domain/workspaces/{id}/shell?token=...`
4. Worker proxies the WebSocket to the VM Agent
5. VM Agent validates the JWT against the API's JWKS endpoint (`/.well-known/jwks.json`)

## Bootstrap Security

When a new VM starts, cloud-init receives only the short-lived bootstrap/callback material needed to contact the control plane; long-lived provider and repository credentials are fetched through the bootstrap exchange:

1. API creates a one-time bootstrap token (cryptographically random, 15-minute default expiry)
2. Cloud-init starts the VM Agent with control-plane metadata and stores callback JWT material in a root-only file rather than the systemd environment
3. VM Agent redeems the token: `POST /api/bootstrap/{token}`
4. API returns the full configuration and encrypted credential payloads needed for the node
5. Token is invalidated after use

## VM TLS Certificates

New nodes use per-node Origin CA key material rather than a platform-shared private key:

1. The API Worker passes a node-scoped certificate endpoint into cloud-init (`apps/api/src/services/nodes.ts`).
2. Cloud-init generates `/etc/sam/tls/origin-ca-key.pem` locally on the VM, creates a CSR, and posts only that CSR to `POST /api/nodes/:id/origin-ca-certificate` with the node callback JWT (`packages/cloud-init/src/template.ts`).
3. The API Worker verifies the callback token is node-scoped and matches `:id`, then signs the CSR through Cloudflare Origin CA using `CF_API_TOKEN` (`apps/api/src/routes/node-lifecycle.ts`, `apps/api/src/services/origin-ca-certificates.ts`).
4. The VM stores the returned certificate at `/etc/sam/tls/origin-ca.pem` and starts the VM agent with `TLS_CERT_PATH` and `TLS_KEY_PATH`.

The certificate hostnames remain wildcard-scoped (`*.BASE_DOMAIN`, `*.vm.BASE_DOMAIN`, and `BASE_DOMAIN`) so existing `ws-*` and `{node}.vm` routing continues to work. The private key is no longer shared across nodes or embedded in static cloud-init user-data. Each node receives a distinct private key and short-lived certificate, with `ORIGIN_CA_CERT_VALIDITY_DAYS` defaulting to 7 days.

### Legacy Origin CA Rotation

Deployments created before the per-node CSR model may have running nodes that still hold a broadly distributed wildcard `ORIGIN_CA_KEY`. Rotate that legacy material by draining or deleting old nodes, deploying the per-node certificate model, revoking the old wildcard Origin CA certificate in Cloudflare SSL/TLS → Origin Server, and removing any manually configured `ORIGIN_CA_CERT`/`ORIGIN_CA_KEY` Worker secrets. New nodes do not require those Worker secrets.

## Security Best Practices

- **Rotate keys quarterly** — regenerate JWT and encryption keys
- **Minimal GitHub App permissions** — only Contents (read/write), Metadata (read-only), and Email addresses (read-only)
- **HTTPS everywhere** — all traffic encrypted via Cloudflare
- **Session isolation** — each workspace JWT is scoped to a specific workspace ID
- **Per-user credential isolation** — each user's cloud/agent secrets are encrypted with a per-credential IV and are never shared between users

:::caution
Rotating the credential-encryption key will make existing encrypted credentials unreadable. Users will need to reconnect cloud credentials—including any GCP service-account JSON—and re-enter agent API keys after key rotation.
:::
