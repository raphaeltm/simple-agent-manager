# Renew Instant workspace callback tokens through the container DO

## Problem

Instant (cf-container) workspaces do not renew their workspace callback token. The renewal route
refuses them on purpose: a container generation is replaced under the same nodeId, and the route
cannot tell a superseded generation from the current one. A container gets a fresh token on every
cold wake, and containers sleep after `CF_CONTAINER_SLEEP_AFTER` (default 1h) idle. So only an
Instant session kept awake for more than `CALLBACK_TOKEN_EXPIRY_MS` (24h) without sleeping still
hits expired-token 401s, exactly as before the renewal work.

## Context

Decided in `tasks/archive/2026-10-04-workspace-callback-token-renewal.md` (security review MEDIUM).
The `VmAgentContainer` DO always knows its current generation and already talks to it over a
trusted channel (`containerFetch` with a node-management token). That channel can push a fresh
token to the current container only, which makes renewal generation-aware by construction.

## Acceptance Criteria

- [ ] Measure first: how often Instant sessions stay awake past 24h in production (Workers Logs
      401s from cf-container nodes); close this task if it never happens
- [ ] If needed, the DO pushes a fresh workspace token (keeping `gen_iat`) to its current container
      before expiry, on its existing keepalive alarm
- [ ] A superseded generation never receives a token, proven by a test that replaces the
      generation and checks that the old one gets nothing
