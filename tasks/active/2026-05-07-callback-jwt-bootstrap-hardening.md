# Callback Token/JWT Hardening and Bootstrap Token Lifecycle

**Date**: 2026-05-07
**Source**: Evaluation findings F-004 (HIGH-3), F-010 (DF-01)
**Priority**: P0

## Problem Statement

Two P0 findings from the 2026-05-07 codebase evaluation require security hardening:

1. **F-004 (HIGH-3): Callback JWT stored plaintext in KV bootstrap data** — The `BootstrapTokenData` stored in KV contains the `callbackToken` (a 24-hour RS256 JWT granting workspace API access) as a plaintext string, while Hetzner and GitHub tokens in the same blob are correctly AES-GCM encrypted. Anyone who can read KV can extract a long-lived callback token.

2. **F-010 (DF-01): Dual callback token validation paths** — Callback token validation has two independent code paths with divergent rejection logic. `verifyAIProxyAuth()` in `ai-proxy-shared.ts` explicitly rejects `scope !== 'workspace'` tokens, while `verifyCallbackToken()` in `jwt.ts` does not include this check. Divergent validation logic is a maintenance hazard.

## Research Findings

### Bootstrap Token Flow
- `storeBootstrapToken()` in `apps/api/src/services/bootstrap.ts:43-53` stores `BootstrapTokenData` as JSON in KV
- `BootstrapTokenData` in `packages/shared/src/types/workspace.ts:245-256` has `callbackToken: string` — plaintext
- `encryptedHetznerToken` and `encryptedGithubToken` are encrypted — callbackToken is not
- Bootstrap tokens are single-use with 15-minute TTL (delete-on-read)
- The callbackToken itself has 24-hour lifetime, extending far beyond bootstrap window
- Redemption in `apps/api/src/routes/bootstrap.ts:62-115` decrypts Hetzner/GitHub but passes callbackToken through

### Callback Token Validation
- `verifyCallbackToken()` in `apps/api/src/services/jwt.ts:190-223` validates audience, type, workspace claim, but does NOT check scope
- `verifyAIProxyAuth()` in `apps/api/src/services/ai-proxy-shared.ts:50-92` calls `verifyCallbackToken()` then additionally rejects `scope !== 'workspace'`
- A node-management-scoped token would pass `jwt.ts` but be rejected by `ai-proxy-shared.ts`
- The scope check should be part of the shared validation function

### VM Agent Side
- Go bootstrap contract tests exist in `packages/vm-agent/internal/bootstrap/contract_test.go`
- Callback token sent as `Authorization: Bearer <token>` — consistent across boundaries
- VM agent sends callback token in workspace callbacks (`workspace_callbacks.go`)

## Implementation Checklist

### 1. Encrypt callbackToken in bootstrap KV data
- [ ] Add `encryptedCallbackToken` and `callbackTokenIv` fields to `BootstrapTokenData` type
- [ ] Mark `callbackToken` as optional (backward compat during migration)
- [ ] Update `storeBootstrapToken` callers (runtime.ts) to encrypt callbackToken before storing
- [ ] Update `redeemBootstrapToken` usage (bootstrap.ts route) to decrypt callbackToken
- [ ] Update existing bootstrap service tests
- [ ] Add test: bootstrap store encrypts callbackToken
- [ ] Add test: bootstrap redeem decrypts callbackToken correctly

### 2. Unify callback token validation with scope parameter
- [ ] Add `expectedScope` optional parameter to `verifyCallbackToken()` in jwt.ts
- [ ] When `expectedScope` is provided, reject tokens that don't match
- [ ] Update `verifyAIProxyAuth()` to pass `expectedScope: 'workspace'` instead of doing its own scope check
- [ ] Update all other callers of `verifyCallbackToken()` to pass expected scope where appropriate
- [ ] Add contract test: both validation paths reject same malformed tokens
- [ ] Add test: node-scoped token rejected when workspace scope expected
- [ ] Add test: workspace-scoped token accepted when workspace scope expected
- [ ] Add test: legacy token (no scope) behavior is preserved

### 3. Documentation
- [ ] Create `docs/architecture/callback-auth-contract.md` documenting the unified contract with code-path citations
- [ ] Update `docs/architecture/secrets-taxonomy.md` to note callbackToken encryption in bootstrap

## Acceptance Criteria

- [ ] Callback validation behavior is unified/documented with code-path citations
- [ ] Bootstrap callbackToken is encrypted at rest in KV
- [ ] Tests cover success and failure modes across Worker and VM agent boundaries
- [ ] API tests pass
- [ ] Go tests pass (or blockers documented with exact evidence)
