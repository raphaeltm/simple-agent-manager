# Post-Mortem: Node heartbeat token expiry causes permanent unhealthy status

**Date**: 2026-03-06

## What broke

Nodes became permanently unhealthy after ~24 hours. Every heartbeat from the VM agent to the API returned HTTP 500 because the JWT callback token (used for authentication) had expired. The node could never recover without a restart.

## Root cause

The callback token is signed once at node provisioning time (`apps/api/src/services/nodes.ts:115` via `signCallbackToken()`) with a 24-hour default expiry (`CALLBACK_TOKEN_EXPIRY_MS`). The token is baked into cloud-init as an environment variable and loaded into the VM agent's config at startup (`packages/vm-agent/internal/config/config.go`). The VM agent uses this static token for all subsequent heartbeat requests (`packages/vm-agent/internal/server/health.go:sendNodeHeartbeat()`). After 24 hours, `verifyCallbackToken()` in `apps/api/src/services/jwt.ts` throws a token expiration error, causing the heartbeat endpoint to return 500. No mechanism existed to refresh the token.

This was present since the initial callback token implementation — it was not introduced by a specific breaking change, but rather was a missing feature that became apparent when nodes lived longer than 24 hours (especially manually provisioned nodes that are not subject to cleanup).

## Timeline

- **Token system introduced**: When node heartbeat authentication was added
- **Bug discovered**: 2026-03-06, after observing nodes going unhealthy ~24h after provisioning
- **Fix merged**: This PR

## Why it wasn't caught

1. **No long-running integration tests**: Tests exercise token signing and verification but not the token lifecycle over time
2. **Short-lived staging tests**: Staging testing typically runs for minutes, not 24+ hours
3. **Auto-provisioned nodes masked it**: Auto-provisioned nodes from task runners are typically destroyed well before 24 hours. Only manually provisioned long-lived nodes exhibited the issue consistently.

## Class of bug

**Time-dependent credential expiry without renewal** — a credential is issued with a finite lifetime but no mechanism to renew it before or after expiry. The system works correctly for the initial lifetime window but degrades permanently once the credential expires.

## Process fix

No process file changes in this PR. The class of bug (time-dependent expiry) is difficult to catch with standard unit/integration tests. The fix itself (auto-refresh via heartbeat response) is the appropriate mitigation — it makes the system self-healing as long as heartbeats continue flowing.

Future consideration: for any new token/credential with a finite lifetime, ensure a renewal mechanism is designed alongside the initial issuance.
