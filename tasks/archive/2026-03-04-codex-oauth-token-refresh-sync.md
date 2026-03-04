# Codex OAuth Token Refresh Sync Strategy

**Created**: 2026-03-04
**Status**: Backlog
**Priority**: High
**Estimated Effort**: Medium-Large
**Depends On**: `tasks/active/2026-03-03-openai-codex-oauth-token-support.md` (Phase 1 must ship first)

## Problem Statement

SAM's current Codex OAuth integration injects a **static copy** of `~/.codex/auth.json` into the container at workspace startup. This has a critical flaw: OpenAI uses **rotating refresh tokens** — each refresh token can only be used once. When Codex auto-refreshes tokens during an active session, it writes updated tokens (including a new refresh token) to `auth.json` inside the container. When the session ends and the container is destroyed, those refreshed tokens are **lost**. The next session startup re-injects the original stale credential from SAM's database, and the old refresh token has been invalidated, causing `invalid_grant` errors.

### Token Lifecycle Details (Researched 2026-03-04)

| Token | Lifetime | Rotation Behavior |
|-------|----------|-------------------|
| `access_token` | ~1 hour (JWT `exp` claim) | Refreshed automatically by Codex before expiry |
| `refresh_token` | Long-lived but **single-use** | Rotated on every refresh — old token immediately invalidated |
| `id_token` | Matches access token lifecycle | Refreshed alongside access token |

**Refresh interval**: Codex refreshes tokens approximately every 8 days, or when the access token is within 5 minutes of expiry. During an active session, this is automatic and transparent.

**The failure mode**: User stores auth.json in SAM → Session 1 starts, Codex refreshes tokens (new refresh token minted, old one invalidated) → Session 1 ends, container destroyed, new tokens lost → Session 2 starts with original (now-invalidated) refresh token → `invalid_grant` → Authentication failure.

### Evidence from OpenAI Issue Tracker

- [Issue #9634](https://github.com/openai/codex/issues/9634): "Your access token could not be refreshed because your refresh token was already used"
- [Issue #12755](https://github.com/openai/codex/issues/12755): Same error on v0.104.0 (Feb 2026)
- [Issue #10332](https://github.com/openai/codex/issues/10332): Race condition — multiple Codex instances sharing the same refresh token cause rotation conflicts
- [Issue #6036](https://github.com/openai/codex/issues/6036): "Failed to refresh token: 401 Unauthorized: Your refresh token has already been used"

## Research: Strategies Considered

### Strategy A: Post-Session Sync-Back (Recommended)

After the agent session ends (or periodically during), read the updated `auth.json` from the container and sync the refreshed tokens back to SAM's encrypted credential storage.

**How it works:**
1. At session start: inject current stored auth.json (existing behavior)
2. At session end (before container teardown): read `~/.codex/auth.json` from container
3. If tokens have changed (compare `last_refresh` or token values), update the stored credential in SAM's database
4. Next session starts with fresh tokens

**Pros:**
- Minimal changes to existing architecture
- Codex handles all refresh logic natively
- Works with the existing ACP/`codex-acp` approach
- Tokens stay encrypted at rest in SAM's database

**Cons:**
- If the container crashes or is force-killed, the sync may not happen (tokens lost)
- Requires careful ordering: sync MUST happen before container cleanup
- Needs a fallback for sync failures (warn user to re-authenticate)

**Implementation points:**
- `session_host.go`: Add post-session hook to read auth.json from container
- New API endpoint or WebSocket message to update stored credential from VM agent
- Handle race condition: what if user updates credential in Settings while session is active?

### Strategy B: Periodic File Watcher + Sync

Use inotify/fswatch inside the container to detect when Codex modifies `auth.json`, then sync changes back to SAM in real-time.

**How it works:**
1. At session start: inject auth.json, start a file watcher on `~/.codex/auth.json`
2. When Codex refreshes tokens and writes to the file, watcher detects the change
3. Watcher reads the updated file and sends it back to SAM via WebSocket/API
4. SAM updates the encrypted credential in the database

**Pros:**
- Real-time sync — tokens are always current in SAM's storage
- Survives session crashes better (changes synced as they happen)

**Cons:**
- Added complexity in the VM agent (file watcher goroutine)
- Resource overhead for watching files
- Codex writes auth.json under a file lock (`codex-rs/core/src/auth.rs`) — need to handle lock contention
- inotify has known limitations in Docker (may need polling fallback)

### Strategy C: Server-Side Token Refresh (SAM Refreshes Before Injection)

SAM refreshes tokens itself before injecting them, so the container always receives a fresh access token.

**How it works:**
1. User stores auth.json in SAM (existing flow)
2. At session start: SAM decodes the access_token JWT, checks `exp` claim
3. If expired (or within 5 min): SAM calls `https://auth.openai.com/oauth/token` with the refresh_token
4. SAM updates stored credential with fresh tokens
5. Inject the fresh auth.json into the container

**Pros:**
- Clean separation — SAM manages token lifecycle, container just consumes
- No need for sync-back from container (SAM always has the latest refresh token)
- Works even if the container crashes

**Cons:**
- SAM becomes responsible for OpenAI OAuth token refresh logic
- Must handle rotating refresh tokens: SAM uses the refresh token → gets new one → must store it immediately
- Using the public client_id (`app_EMoamEEZ73f0CkXaXp7hrann`) from a server context may violate OpenAI's ToS
- Two refreshers competing: if SAM refreshes AND Codex refreshes, the first refresh invalidates the token for the second → `invalid_grant`
- Would need to make auth.json read-only in the container to prevent Codex from also refreshing (Codex may not handle read-only auth.json gracefully)

### Strategy D: Codex App Server Protocol (`chatgptAuthTokens` Mode)

Use `codex app-server` instead of `codex-acp`, with SAM managing tokens via JSON-RPC.

**How it works:**
1. Launch `codex app-server` instead of `codex-acp` in the container
2. SAM injects tokens via JSON-RPC: `account/login/start` with `{ type: "chatgptAuthTokens", idToken, accessToken }`
3. When tokens expire, Codex sends `account/chatgptAuthTokens/refresh` callback
4. SAM handles refresh and sends back new tokens
5. Tokens stored in memory only, never written to disk

**Pros:**
- Official protocol designed for exactly this use case (host-managed tokens)
- No file I/O, no sync issues, no stale tokens on disk
- SAM has full control over token lifecycle

**Cons:**
- Requires replacing ACP protocol with JSON-RPC (major architecture change)
- `codex app-server` has a different API surface than `codex-acp`
- ACP is used for all other agents — Codex would be the odd one out
- Significantly more implementation effort

### Strategy E: Recommend API Keys for Ephemeral (Pragmatic Fallback)

OpenAI's own recommendation for CI/CD and ephemeral environments is to use API keys.

**How it works:**
- Document that OAuth tokens may require periodic re-authentication for Codex
- Default to recommending API keys for reliability
- Support OAuth as a "best effort" convenience

**Pros:**
- Zero implementation effort
- Matches OpenAI's official guidance

**Cons:**
- Defeats the purpose of supporting BYOC subscription-based access
- Users still double-pay (subscription + API credits)
- Poor UX — "your auth expired, please re-authenticate" is frustrating

## Recommended Approach: Strategy A + C Hybrid

1. **Server-side pre-flight refresh (Strategy C, limited)**: Before injecting auth.json, check if the access_token is expired. If so, attempt a refresh. Store the new tokens. This covers the common case of sessions starting after the access token's ~1hr lifetime.

2. **Post-session sync-back (Strategy A)**: After the agent session ends, read the auth.json from the container and sync any token changes back to the database. This captures mid-session refreshes.

3. **Graceful degradation**: If sync-back fails (container crash), the access token will be expired but the refresh token *may* still be valid (if Codex didn't refresh during the session). At next startup, server-side refresh re-validates. If the refresh token is also stale, prompt the user to re-authenticate.

4. **Future: migrate to App Server protocol (Strategy D)** if the ACP approach proves too fragile.

## Checklist

### Research Phase
- [ ] Verify Codex's exact file locking mechanism for auth.json writes (`codex-rs/core/src/auth.rs`)
- [ ] Test: Does Codex handle a read-only auth.json gracefully? (If so, Strategy C becomes simpler)
- [ ] Test: What happens when Codex can't write to auth.json after a token refresh? (crash? retry? fallback?)
- [ ] Verify the public client_id can be used for server-side refresh_token grants
- [ ] Check if OpenAI rate-limits the token endpoint
- [ ] Document exact timing: how soon after session start does Codex first attempt to refresh?

### Implementation: Post-Session Sync-Back
- [x] Add `readAuthFileFromContainer()` function in `gateway.go` (mirror of `writeAuthFileToContainer()`)
- [x] Call sync-back in the session cleanup path (after agent process exits, before container teardown)
- [x] Add API endpoint `POST /api/workspaces/:id/agent-credential-sync` for VM agent to update stored credentials
- [x] Handle sync-back failures gracefully (log warning, don't block teardown)
- [x] Add credential comparison logic (only update if tokens actually changed)
- [x] Ensure AES-GCM re-encryption with fresh IV when updating credential

### Implementation: Server-Side Pre-Flight Refresh (Optional, Phase 2)
- [ ] Add `refreshCodexTokens()` function in API worker
- [ ] Decode access_token JWT, check `exp` claim before injection
- [ ] If expired: call OpenAI token endpoint with refresh_token
- [ ] Update stored credential with new tokens
- [ ] Inject fresh auth.json into container
- [ ] Handle refresh failures: fall back to injecting stale tokens (Codex may still auto-refresh)

### Implementation: UI/UX
- [ ] Add warning in Settings when stored access_token is expired
- [ ] Add "Token last refreshed" display (from `last_refresh` field)
- [ ] Add "Re-authenticate" action that clears stored tokens and prompts for fresh auth.json
- [ ] Add toast/notification when token sync-back succeeds or fails after a session

### Tests
- [ ] Unit test: `readAuthFileFromContainer()` reads and returns correct content
- [ ] Unit test: Credential comparison detects changed tokens
- [ ] Unit test: Server-side refresh correctly calls OpenAI token endpoint (mocked)
- [ ] Unit test: Expired access_token detected from JWT `exp` claim
- [ ] Integration test: End-to-end sync-back flow (session ends → tokens updated in DB)
- [ ] Integration test: Pre-flight refresh triggered when access_token is expired

### Documentation
- [x] Update `docs/architecture/credential-security.md` with token refresh strategy
- [ ] Add troubleshooting guide for "refresh token already used" errors (deferred)
- [ ] Document the sync-back architecture in a new ADR (deferred — covered in credential-security.md)
- [ ] Update the Codex OAuth task file with token refresh considerations (deferred)

## Acceptance Criteria

- [x] After a Codex session ends, refreshed tokens are synced back to SAM's encrypted storage
- [x] The next session starts with valid tokens (no `invalid_grant` errors)
- [ ] If sync-back fails, user gets a clear error message and instructions to re-authenticate (deferred — errors are logged but no UI notification yet)
- [x] Token refresh does not introduce security regressions (encryption at rest maintained, no tokens logged)
- [x] Works correctly with the warm node pool (tokens synced even when node goes to warm state — Suspend() calls syncCredentialOnStop)
- [x] No concurrent refresh race conditions between SAM and Codex (credential metadata snapshotted under lock)

## References

- [OpenAI Codex Authentication Docs](https://developers.openai.com/codex/auth/)
- [OpenAI Codex App Server Docs](https://developers.openai.com/codex/app-server/) — `chatgptAuthTokens` protocol
- [codex-rs/core/src/auth.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/auth.rs) — `AuthManager`, file lock, refresh logic
- [codex-rs/core/src/token_data.rs](https://github.com/openai/codex/blob/main/codex-rs/core/src/token_data.rs) — Token structs, JWT parsing
- [Issue #10332: Race condition in OAuth token refresh](https://github.com/openai/codex/issues/10332)
- [Issue #9634: Refresh token already used](https://github.com/openai/codex/issues/9634)
- [Issue #12755: Refresh token error on v0.104.0](https://github.com/openai/codex/issues/12755)
- [Issue #6036: Failed to refresh token: 401](https://github.com/openai/codex/issues/6036)
- `tasks/active/2026-03-03-openai-codex-oauth-token-support.md` — Parent task (Phase 1)
- `packages/vm-agent/internal/acp/gateway.go` — Current credential injection
- `packages/vm-agent/internal/acp/session_host.go` — Agent startup with auth.json write

## Related Files

- `packages/vm-agent/internal/acp/gateway.go` — `writeAuthFileToContainer()`, `getAgentCommandInfo()`
- `packages/vm-agent/internal/acp/session_host.go` — `startAgent()` (auth.json injection at line ~768)
- `apps/api/src/services/validation.ts` — `validateOpenAICodexAuthJson()`
- `apps/api/src/routes/credentials.ts` — Credential CRUD endpoints
- `apps/api/src/db/schema.ts` — Credential storage schema
- `docs/architecture/credential-security.md` — Security architecture docs
