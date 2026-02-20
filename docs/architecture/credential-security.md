# Credential Security Architecture

## Overview

Simple Agent Manager uses a **Bring-Your-Own-Cloud (BYOC)** model where users provide their own cloud provider credentials (e.g., Hetzner API tokens). This document describes how these credentials are secured.

## Key Principle

**The platform does NOT have cloud provider credentials.** Users bring their own.

```
┌─────────────────────────────────────────────────────────────────┐
│                    CREDENTIAL FLOW                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   User                    Platform                    Cloud      │
│   ────                    ────────                    ─────      │
│                                                                  │
│   1. User enters          2. Platform encrypts       3. When     │
│      Hetzner token           with ENCRYPTION_KEY       workspace │
│      in Settings UI          and stores per-user       created,  │
│                              in D1 database            decrypt   │
│                                                        and use   │
│                                                                  │
│   ┌──────────┐           ┌──────────────┐          ┌──────────┐ │
│   │ Settings │ ────────► │  Encrypted   │ ───────► │ Hetzner  │ │
│   │   Form   │           │  in D1 (per  │          │   API    │ │
│   └──────────┘           │    user)     │          └──────────┘ │
│                          └──────────────┘                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Database Schema

User credentials are stored in the `credentials` table:

```sql
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,           -- e.g., 'hetzner'
  encrypted_token TEXT NOT NULL,    -- AES-GCM encrypted
  iv TEXT NOT NULL,                 -- Unique initialization vector
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

### Key Security Features

1. **Per-user isolation**: Each credential is tied to a specific `user_id`
2. **Unique IV per credential**: Every encrypted token has its own initialization vector
3. **Cascade delete**: When a user is deleted, their credentials are automatically removed
4. **Provider separation**: Different providers stored as separate records

## Encryption Implementation

### Encryption (when user saves token)

```typescript
// 1. Generate unique IV for this credential
const iv = crypto.getRandomValues(new Uint8Array(12));

// 2. Import the platform's ENCRYPTION_KEY
const key = await crypto.subtle.importKey(
  'raw',
  base64Decode(env.ENCRYPTION_KEY),
  { name: 'AES-GCM' },
  false,
  ['encrypt']
);

// 3. Encrypt the token
const encrypted = await crypto.subtle.encrypt(
  { name: 'AES-GCM', iv },
  key,
  new TextEncoder().encode(token)
);

// 4. Store encrypted_token + iv in database
```

### Decryption (when provisioning workspace)

```typescript
// 1. Fetch credential from database (WHERE user_id = currentUser.id)
const credential = await db.query.credentials.findFirst({
  where: and(
    eq(credentials.userId, userId),
    eq(credentials.provider, 'hetzner')
  )
});

// 2. Decrypt using stored IV
const key = await crypto.subtle.importKey(...);
const decrypted = await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: base64Decode(credential.iv) },
  key,
  base64Decode(credential.encryptedToken)
);

// 3. Use token for Hetzner API call
const hetznerClient = new HetznerClient(decryptedToken);
```

### Decryption (project runtime assets for workspace injection)

Project runtime env vars/files can be marked secret per entry. Secret entries are encrypted at rest in D1 and only decrypted when a workspace requests runtime assets via callback-authenticated API.

Runtime flow:

1. VM agent calls `GET /api/workspaces/:id/runtime-assets` with workspace callback token
2. Control plane loads workspace `project_id`
3. Control plane loads `project_runtime_env_vars` and `project_runtime_files`
4. Secret rows are decrypted in-memory using `ENCRYPTION_KEY`
5. Decrypted payload is returned over HTTPS for immediate VM injection

## What This Means

### Platform Secrets (Cloudflare Worker Secrets)

These are set once during deployment and managed by the platform operator:

| Secret | Purpose | Who Sets It |
|--------|---------|-------------|
| `ENCRYPTION_KEY` | Encrypt user credentials | Platform operator |
| `JWT_PRIVATE_KEY` | Sign authentication tokens | Platform operator |
| `JWT_PUBLIC_KEY` | Verify authentication tokens | Platform operator |
| `CF_API_TOKEN` | DNS operations for workspaces | Platform operator |
| `CF_ZONE_ID` | DNS zone for workspace subdomains | Platform operator |
| `GITHUB_CLIENT_*` | OAuth authentication | Platform operator |

### User Credentials (Encrypted in Database)

These are provided by each user through the Settings UI:

| Credential | Purpose | Who Provides It |
|------------|---------|-----------------|
| Hetzner API Token | Provision VMs | Each user |
| (Future: AWS, GCP, etc.) | Provision resources | Each user |

### Project Runtime Secrets (Encrypted in Database)

Projects support runtime env vars and runtime files as plaintext or secret values:

| Data | Storage | Encryption Behavior |
|------|---------|---------------------|
| Runtime env vars | `project_runtime_env_vars` | Secret rows use AES-GCM (`stored_value` + `value_iv`) |
| Runtime files | `project_runtime_files` | Secret rows use AES-GCM (`stored_content` + `content_iv`) |

Secret values are masked in project runtime-config list responses and only decrypted in callback-authenticated runtime asset responses for workspace provisioning.

## Security Considerations

### Why BYOC?

1. **Cost transparency**: Users pay their own cloud bills directly
2. **No platform liability**: Platform doesn't hold keys to expensive resources
3. **User control**: Users can revoke access anytime by regenerating their token
4. **Compliance**: Some organizations require credentials stay within their control

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Database breach | Credentials encrypted with AES-GCM |
| ENCRYPTION_KEY leak | Rotate key, re-encrypt all credentials |
| Token in logs | Never log decrypted tokens |
| Cross-user access | Always filter by `user_id` in queries |
| Replay attacks | Unique IV per credential |

### What We Do NOT Do

- Store Hetzner tokens as environment variables
- Store Hetzner tokens as Worker secrets
- Share credentials between users
- Log decrypted credentials
- Send credentials to the browser

## Key Rotation

If `ENCRYPTION_KEY` needs to be rotated:

1. Deploy new key alongside old key
2. Re-encrypt all credentials with new key
3. Remove old key
4. This is a manual process requiring database migration

## OAuth Token Encryption (BetterAuth)

In addition to user-provided cloud credentials, the platform also encrypts **OAuth tokens** stored by BetterAuth during GitHub login. This is enabled via BetterAuth's built-in `encryptOAuthTokens` option in the account configuration.

### What Is Encrypted

The following fields in the `accounts` table are encrypted at rest:

| Field | Description |
|-------|-------------|
| `access_token` | GitHub OAuth access token used for API calls |
| `refresh_token` | GitHub OAuth refresh token (when available) |
| `id_token` | OpenID Connect ID token (when available) |

### How It Works

- BetterAuth uses the `secret` value (our `ENCRYPTION_KEY`) to encrypt these token fields before writing them to D1.
- Decryption happens transparently when BetterAuth reads account records.
- No application code changes are needed beyond enabling the flag — BetterAuth handles encryption/decryption internally.

### Migration of Existing Tokens

Existing plaintext tokens in the `accounts` table will be re-encrypted on the next user login. This works because `overrideUserInfoOnSignIn` is already enabled in the GitHub social provider config, which causes BetterAuth to overwrite account data (including tokens) on each sign-in.

### Why This Matters

Without this setting, GitHub OAuth tokens are stored as plaintext in D1. If the database were compromised, an attacker could use these tokens to access users' GitHub accounts (within the granted scopes: `read:user`, `user:email`). Encrypting them at rest ensures that a database breach alone does not expose usable tokens.

## Related Documentation

- [Secrets Taxonomy](./secrets-taxonomy.md) - Full breakdown of all secrets
- [spec/003-browser-terminal-saas](../../specs/003-browser-terminal-saas/data-model.md) - Original data model
