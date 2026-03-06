# Fix: Node heartbeat callback token expiry causes permanent unhealthy status

## Problem

Nodes become permanently unhealthy after ~24 hours. The callback JWT token used by the VM agent to authenticate heartbeats to the API is signed at provisioning time with a 24h default expiry (`CALLBACK_TOKEN_EXPIRY_MS`), baked into cloud-init, and never refreshed. After expiry, `verifyCallbackToken()` throws on every heartbeat → API returns 500 → node marked unhealthy.

This especially affects manually provisioned nodes which can live indefinitely.

## Research Findings

- **Token generation**: `apps/api/src/services/jwt.ts:signCallbackToken()` — 24h default expiry
- **Token injection**: `apps/api/src/services/nodes.ts:115` → `packages/cloud-init/src/generate.ts` → cloud-init env var
- **VM agent sends heartbeat**: `packages/vm-agent/internal/server/health.go:sendNodeHeartbeat()` — uses static `s.config.CallbackToken`
- **API receives heartbeat**: `apps/api/src/routes/nodes.ts:507-554` — calls `verifyNodeCallbackAuth()` which calls `verifyCallbackToken()`
- **No refresh mechanism exists** — token is fire-and-forget

## Implementation Checklist

- [ ] Add `shouldRefreshCallbackToken()` to `apps/api/src/services/jwt.ts`
- [ ] Update heartbeat handler in `apps/api/src/routes/nodes.ts` to return `refreshedToken` when nearing expiry
- [ ] Add `CALLBACK_TOKEN_REFRESH_THRESHOLD_RATIO` to Env interface in `apps/api/src/index.ts`
- [ ] Add `callbackTokenMu` + `callbackToken` fields to Server struct in `packages/vm-agent/internal/server/server.go`
- [ ] Update `sendNodeHeartbeat()` and `sendNodeReady()` in `health.go` to use mutex-guarded token and parse refresh response
- [ ] Add unit tests for `shouldRefreshCallbackToken()`
- [ ] Add Go tests for token refresh behavior
- [ ] Run full quality suite: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`

## Acceptance Criteria

- [ ] Heartbeat continues working past the 24h token expiry window
- [ ] VM agent logs token refresh at INFO level
- [ ] No change in behavior for tokens that aren't near expiry
- [ ] All existing tests pass
- [ ] New tests cover the refresh logic
