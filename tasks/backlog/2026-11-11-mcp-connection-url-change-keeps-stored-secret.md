# MCP connection URL change keeps the stored secret

## Problem

`updateMcpConnection` (`apps/api/src/services/mcp-connections.ts`, the `input.url !== undefined`
branch) re-encrypts a new URL but keeps the stored bearer token and sealed headers unless the
caller also sends `token`/`headers`. Anyone allowed to PATCH a connection can therefore point it at
a host they control and have the next agent run send the stored secret there, without ever being
able to read the secret. For project connections that includes project members who did not add
the secret (`requireProjectRuntimeAuthorization`), and an agent sign-in session acting as the
target user.

## Context

Found 2026-11-11 while enumerating lasting-access paths for agent sign-in sessions (PR #2649,
task `01M75A21P5H2T3VXANW3GK8JX2`). Pre-existing; not introduced by that PR.

## Acceptance Criteria

- [ ] Changing a connection's URL host without supplying a new token (bearer) or new secret
      headers clears the stored secret or is refused with a clear 400.
- [ ] Same-host URL edits (path changes) keep working without re-entering the secret, or the
      choice is documented.
- [ ] Real-SQL tests: host change without token is refused/cleared; same-host change keeps
      the secret; owner-path control; a project member cannot redirect another member's secret.
