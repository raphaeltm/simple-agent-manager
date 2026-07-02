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
- [x] Verify staging with a live conversation-mode task and production with non-mutating probes/log checks.

## Verification

- Local focused tests: `pnpm --filter @simple-agent-manager/api test -- workspace-proxy-ownership.test.ts node-agent-contract.test.ts` (65 passed).
- API typecheck: `pnpm --filter @simple-agent-manager/api typecheck`.
- API lint: `pnpm --filter @simple-agent-manager/api lint` (exited 0 with pre-existing warning-only output).
- Staging deploy: GitHub Actions `deploy-staging.yml` run `25546500678` succeeded, including smoke tests.
- Staging live task: submitted conversation task `01KR3D1BKGTBSDKZ9FKRDN0W82`, session `eb4c858f-b52d-4655-b499-f89cbd44b6ff`, workspace `01KR3D5775CW48ZBWPZVNW58H6`.
- Staging WebSocket: token-only project-chat ACP URL returned `HTTP/1.1 101 Switching Protocols` and `session_state` with `status: ready`.
- Staging follow-up: sent a follow-up `session/prompt` over the same WebSocket and received `session_prompting`.
- Cleanup: closed the staging conversation task and deleted workspace `01KR3D5775CW48ZBWPZVNW58H6` and node `01KR3D1FY3G4FEY627T1H2N2JZ`.
- Production non-mutating check: production workspace-subdomain request currently returns proxy-level `401 UNAUTHORIZED` without app cookie, matching the deployed regression before this fix reaches production.

## Acceptance Criteria

- Project chat ACP WebSocket requests with valid terminal tokens are proxied to the VM agent even when no app session cookie is present on the workspace subdomain.
- Invalid, expired, or wrong-user terminal tokens do not authorize workspace proxy access.
- Existing session-cookie ownership checks still protect workspace proxy requests.
- Live staging conversation mode accepts a follow-up message after the agent starts.
