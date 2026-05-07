# Callback Token Authentication Contract

## Overview

Callback tokens are RS256 JWTs issued by the control plane for VM agents to authenticate API requests. There are two scopes:

- **`workspace`** — scoped to a specific workspace; used for workspace lifecycle callbacks (ready, boot-log, messages, agent sessions)
- **`node`** — scoped to a node; used for node-level operations (heartbeat, error reporting)

## Token Signing

| Function | File | Scope | Audience |
|----------|------|-------|----------|
| `signCallbackToken()` | `apps/api/src/services/jwt.ts` | `workspace` | `workspace-callback` |
| `signNodeCallbackToken()` | `apps/api/src/services/jwt.ts` | `node` | `workspace-callback` |

Both produce tokens with:
- Algorithm: RS256
- Issuer: `https://api.${BASE_DOMAIN}`
- Audience: `workspace-callback`
- Expiry: configurable via `CALLBACK_TOKEN_EXPIRY_HOURS` (default: 24h)
- Claims: `{ type: 'callback', workspace: <id>, scope: 'workspace' | 'node' }`

## Token Validation (Unified)

All callback token validation goes through a single function:

```
verifyCallbackToken(token, env, options?)
```
**File:** `apps/api/src/services/jwt.ts`

This function:
1. Verifies RS256 signature against `JWT_PUBLIC_KEY`
2. Validates issuer matches `https://api.${BASE_DOMAIN}`
3. Validates audience is `workspace-callback`
4. Validates `type === 'callback'`
5. Validates `workspace` claim is a string
6. Validates `scope` is one of `'node' | 'workspace' | undefined`
7. **When `options.expectedScope` is provided**: rejects tokens whose scope doesn't match

### Scope Enforcement

Callers that require a specific scope pass `expectedScope`:

| Caller | File | Expected Scope |
|--------|------|---------------|
| `verifyAIProxyAuth()` | `apps/api/src/services/ai-proxy-shared.ts` | `workspace` |

Callers that enforce scope manually (omit `expectedScope`, check `payload.scope` inline):

| Caller | File | Notes |
|--------|------|-------|
| `verifyWorkspaceCallbackAuth()` | `apps/api/src/routes/workspaces/_helpers.ts` | Rejects `node` scope; accepts `workspace` and legacy (undefined) with warning log |
| Codex refresh proxy | `apps/api/src/routes/codex-refresh.ts` | Rejects `node` scope; accepts `workspace` and legacy |
| ACP heartbeat | `apps/api/src/routes/projects/node-acp-heartbeat.ts` | Rejects legacy (scopeless) tokens; accepts `workspace` and `node` |

Callers that accept any valid scope (omit `expectedScope`, no manual check):

| Caller | File | Notes |
|--------|------|-------|
| Node lifecycle heartbeat | `apps/api/src/routes/node-lifecycle.ts` | Accepts both node and workspace tokens |
| Task completion | `apps/api/src/routes/tasks/crud.ts` | Workspace callback for task status |

### Legacy Token Handling

Tokens minted before scope claims were added have `scope: undefined`. These are accepted when no `expectedScope` is specified, but rejected when a specific scope is required.

## VM Agent Contract

The VM agent sends callback tokens as:
```
Authorization: Bearer <token>
```

This is verified in Go contract tests at `packages/vm-agent/internal/bootstrap/contract_test.go`.

## Bootstrap Token Encryption (F-004)

When bootstrap data is stored in KV for VM credential delivery, the callback token is AES-GCM encrypted at rest — matching the pattern used for Hetzner and GitHub tokens:

| Field | Purpose |
|-------|---------|
| `encryptedCallbackToken` | AES-GCM ciphertext of the callback JWT |
| `callbackTokenIv` | Initialization vector for decryption |

The deprecated `callbackToken` plaintext field is retained for backward compatibility with in-flight bootstrap tokens created before this change.

**Type:** `BootstrapTokenData` in `packages/shared/src/types/workspace.ts`
**Store:** `apps/api/src/routes/workspaces/runtime.ts` (legacy bootstrap endpoint)
**Redeem:** `apps/api/src/routes/bootstrap.ts` (decrypts before returning to VM)
