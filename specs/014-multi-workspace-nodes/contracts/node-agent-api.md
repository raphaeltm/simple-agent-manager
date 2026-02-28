# Node Agent Management API Contract

**Feature**: `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/spec.md`  
**Scope**: Control Plane -> Node Agent management and observability APIs

## Transport and Identity

- Base URL: `http://vm-{nodeId}.${BASE_DOMAIN}:8080`
- Authentication: `Authorization: Bearer <node-management-jwt>`
- Trusted routing headers:
- `X-SAM-Node-Id` is required for all Node Agent management/observability requests.
- `X-SAM-Workspace-Id` is required for workspace-scoped routes.
- Header trust rule: Node Agent only trusts `X-SAM-*` headers from Control Plane ingress; direct client traffic is not an authoritative source.

## Node-Level Endpoints

- `GET /health`
- Returns Node Agent health, active workspace/session counts, and readiness details.

- `GET /events`
- Returns recent Node-level events/log entries.
- Query: `limit`, `cursor`.

## Workspace Lifecycle Endpoints

- `GET /workspaces`
- Lists workspaces currently known to the Node Agent.

- `POST /workspaces`
- Creates a workspace runtime on the node.
- Body includes: `workspaceId`, `repository`, `branch`, `callbackToken`, optional runtime settings.
- `callbackToken` is workspace-scoped and is used by the Node Agent for control-plane callbacks and per-workspace credential fetches.

- `GET /workspaces/{workspaceId}`
- Returns workspace runtime status/details.

- `POST /workspaces/{workspaceId}/stop`
- Stops the workspace runtime but preserves files/configuration.

- `POST /workspaces/{workspaceId}/restart`
- Restarts a stopped workspace runtime.

- `DELETE /workspaces/{workspaceId}`
- Deletes workspace runtime resources from the node.

- `GET /workspaces/{workspaceId}/events`
- Returns recent workspace-scoped events/log entries.
- Query: `limit`, `cursor`.

## Agent Session Endpoints

- `GET /workspaces/{workspaceId}/agent-sessions`
- Lists sessions for a workspace.

- `POST /workspaces/{workspaceId}/agent-sessions`
- Creates a new agent session.
- The VM agent handles session deduplication in-memory (no control-plane KV layer).

- `POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/start`
- Starts the agent process and sends an initial prompt for a previously created session.
- Body: `{ "agentType": "claude-code", "initialPrompt": "..." }`
- Returns 202 with `{ "status": "starting", "sessionId": "..." }`.
- The agent runs asynchronously — no browser WebSocket is required.
- Used by the TaskRunner DO to deliver the task description after creating the session.

- `POST /workspaces/{workspaceId}/agent-sessions/{sessionId}/stop`
- Stops a running agent session.

- `GET /agent/ws?sessionId={optional}&takeover={optional}&idempotencyKey={optional}`
- WebSocket endpoint for attach/create semantics as defined in:
- `/workspaces/hierarchy-planning/specs/014-multi-workspace-nodes/contracts/websocket-protocol.md`

## Error Format

All errors must use:

```json
{ "error": "error_code", "message": "Human-readable description" }
```

Typical codes: `unauthorized`, `forbidden`, `workspace_not_found`, `workspace_not_running`, `session_not_found`, `session_not_running`, `session_already_attached`.

## Related Control Plane Callback Endpoints

Node Agent callback targets exposed by Control Plane:

- `POST https://api.${BASE_DOMAIN}/api/nodes/{nodeId}/ready`
- `POST https://api.${BASE_DOMAIN}/api/nodes/{nodeId}/heartbeat`

These endpoints use callback JWT auth and update Node readiness/heartbeat freshness in Control Plane state.
