# Conversation Mode Agent Offline Regression

## Problem

Conversation mode tasks start and the VM agent continues working, but project chat reports the agent as offline/reconnecting and users cannot send follow-up messages. This breaks the core conversation UX.

## Research Findings

- Recent commit `f2f533cf` hardened workspace proxy ownership in `apps/api/src/index.ts` by requiring a Better Auth session before proxying any `ws-{workspaceId}` request.
- Project chat ACP uses `apps/web/src/hooks/useProjectAgentSession.ts` to fetch a terminal token via `/api/terminal/token`, then connects to `wss://ws-{workspaceId}.{BASE_DOMAIN}/agent/ws?token=...`.
- The VM agent validates that terminal token in `packages/vm-agent/internal/server/workspace_routing.go`, but the API Worker now rejects unauthenticated workspace-subdomain traffic before it reaches the VM agent.
- Production probe against `https://ws-${SAM_WORKSPACE_ID}.simple-agent-manager.org/agent/ws?token=invalid` returned API proxy `401 UNAUTHORIZED`, confirming the proxy short-circuits before VM-agent token validation.
- Relevant prior postmortems: `docs/notes/2026-04-22-chat-agent-session-routing-postmortem.md`, `docs/notes/2026-04-22-chat-idle-cleanup-message-activity-postmortem.md`, `docs/notes/2026-03-06-heartbeat-token-expiry-postmortem.md`.

## Checklist

- [x] Add API-side terminal token verification for workspace proxy requests.
- [x] Preserve workspace ownership enforcement by requiring the token subject to own the workspace.
- [x] Keep app-session auth working for normal authenticated workspace and port proxy access.
- [x] Add regression tests for token-only workspace proxy access and cross-user rejection.
- [x] Run focused tests and typecheck/lint for touched packages.
- [ ] Verify staging with a live conversation-mode task and production with non-mutating probes/log checks.

## Acceptance Criteria

- Project chat ACP WebSocket requests with valid terminal tokens are proxied to the VM agent even when no app session cookie is present on the workspace subdomain.
- Invalid, expired, or wrong-user terminal tokens do not authorize workspace proxy access.
- Existing session-cookie ownership checks still protect workspace proxy requests.
- Live staging conversation mode accepts a follow-up message after the agent starts.
