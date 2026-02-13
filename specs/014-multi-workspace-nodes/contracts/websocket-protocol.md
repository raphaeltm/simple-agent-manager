# WebSocket Protocol: Agent Session Attach

**Feature**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Scope**: Node Agent ACP/WebSocket attach semantics for `Workspace -> Agent Session`

## Connection

- Endpoint: `wss://ws-{workspaceId}.${BASE_DOMAIN}/agent/ws`
- Auth: JWT bearer token passed as query param (`token`) or session cookie.
- Routed context: request includes trusted `nodeId` and `workspaceId` context from Control Plane.
- Trusted headers policy: Control Plane strips client-supplied `X-SAM-*` headers and injects authoritative routing headers (`X-SAM-Node-Id`, `X-SAM-Workspace-Id`).
- Authorization:
- Token subject must map to authenticated user.
- Token `workspace` claim must match routed `workspaceId`.

## Attach Semantics

- Query parameter `sessionId` is optional.
- If `sessionId` is omitted:
- Node Agent creates a new Agent Session.
- Response includes `session.created` event with generated `sessionId`.
- Session creation supports idempotency via optional `idempotencyKey` query parameter; retries with the same key return/attach to the same created running session. This deduplication is handled in-memory by the VM agent (no control-plane KV layer).
- If `sessionId` is provided:
- Node Agent attempts to attach to an existing running session in the same Workspace.
- Response includes `session.attached` event if attach succeeds.
- Interactive attach concurrency:
- By default, one active interactive attachment is allowed per session.
- If another interactive attachment is active, attach returns `409 session_already_attached`.
- Optional `takeover=true` allows explicit replacement of the active interactive attachment.

## Lifecycle Events

Server emits JSON messages:

```json
{ "type": "session.created", "sessionId": "..." }
{ "type": "session.attached", "sessionId": "..." }
{ "type": "session.stopped", "sessionId": "...", "reason": "user_stop|workspace_stop|workspace_restart|node_stop|error" }
{ "type": "agent.output", "sessionId": "...", "data": "..." }
{ "type": "agent.error", "sessionId": "...", "message": "..." }
```

## Error Cases

- `401 unauthorized`: missing/invalid auth token.
- `403 forbidden`: token workspace mismatch or ownership failure.
- `404 session_not_found`: requested `sessionId` does not exist in routed Workspace.
- `409 session_not_running`: requested `sessionId` exists but is stopped.
- `409 workspace_not_running`: Workspace is not running.
- `409 session_already_attached`: session has an active interactive attachment and takeover was not requested.

Error payload shape:

```json
{ "error": "error_code", "message": "Human-readable description" }
```

## Invariants

- Session IDs are unique per Workspace.
- A session can only be attached while status is `running`.
- Workspace stop/restart transitions all sessions to `stopped`.
- Sessions from a different Workspace are never attachable even if session ID is known.
- Stop/attach race handling is deterministic:
- If stop is committed before attach authorization completes, attach fails with `409 session_not_running`.
- If attach succeeds first and stop occurs afterward, server emits `session.stopped` and closes the WebSocket cleanly.
