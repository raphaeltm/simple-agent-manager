# API Contract: DO-Owned ACP Session Management

**Feature**: 027-do-session-ownership | **Date**: 2026-03-11

## Endpoints Overview

All endpoints are on the API Worker (`api.${BASE_DOMAIN}`).

| Method | Path | Purpose | Auth |
|--------|------|---------|------|
| POST | `/api/projects/:projectId/acp-sessions` | Create ACP session | JWT (user) |
| GET | `/api/projects/:projectId/acp-sessions` | List ACP sessions | JWT (user) |
| GET | `/api/projects/:projectId/acp-sessions/:sessionId` | Get ACP session | JWT (user) |
| POST | `/api/projects/:projectId/acp-sessions/:sessionId/assign` | Assign workspace | JWT (system/task-runner) |
| POST | `/api/projects/:projectId/acp-sessions/:sessionId/status` | Report status change | Callback token (VM agent) |
| POST | `/api/projects/:projectId/acp-sessions/:sessionId/heartbeat` | VM agent heartbeat | Callback token (VM agent) |
| POST | `/api/projects/:projectId/acp-sessions/:sessionId/fork` | Fork session | JWT (user) |
| GET | `/api/projects/:projectId/acp-sessions/:sessionId/lineage` | Get fork lineage | JWT (user) |
| GET | `/api/nodes/:nodeId/acp-sessions` | Reconciliation query | Callback token (VM agent) |

---

## POST `/api/projects/:projectId/acp-sessions`

Create a new ACP session. Called by task runner or user action.

**Request:**
```json
{
  "chatSessionId": "string (required — existing chat session ID)",
  "initialPrompt": "string | null (task description)",
  "agentType": "string | null (e.g., 'claude-code')"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "chatSessionId": "string",
  "status": "pending",
  "agentType": "string | null",
  "initialPrompt": "string | null",
  "parentSessionId": null,
  "forkDepth": 0,
  "createdAt": 1741651200000
}
```

**Errors:**
- 400: Missing chatSessionId
- 404: Project or chat session not found
- 422: Chat session belongs to different project

---

## POST `/api/projects/:projectId/acp-sessions/:sessionId/assign`

Assign a workspace and node to a pending session. Called by task runner after provisioning.

**Request:**
```json
{
  "workspaceId": "string (required)",
  "nodeId": "string (required)"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "status": "assigned",
  "workspaceId": "string",
  "nodeId": "string",
  "assignedAt": 1741651200000
}
```

**Errors:**
- 404: Session not found
- 409: Session not in `pending` state
- 422: Workspace not bound to this project

---

## POST `/api/projects/:projectId/acp-sessions/:sessionId/status`

Report ACP session status change. Called by VM agent via callback token.

**Request:**
```json
{
  "status": "running | completed | failed",
  "acpSdkSessionId": "string | null (required for 'running')",
  "errorMessage": "string | null (required for 'failed')",
  "nodeId": "string (required — for identity validation)"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "status": "running | completed | failed",
  "updatedAt": 1741651200000
}
```

**Errors:**
- 404: Session not found
- 409: Invalid state transition
- 403: nodeId doesn't match assigned node

---

## POST `/api/projects/:projectId/acp-sessions/:sessionId/heartbeat`

VM agent periodic heartbeat to prove liveness.

**Request:**
```json
{
  "nodeId": "string (required)",
  "acpSdkSessionId": "string | null"
}
```

**Response:** 204 No Content

**Errors:**
- 404: Session not found
- 409: Session not in `assigned` or `running` state
- 403: nodeId doesn't match assigned node

---

## POST `/api/projects/:projectId/acp-sessions/:sessionId/fork`

Fork a completed/interrupted session with context from the original.

**Request:**
```json
{
  "contextSummary": "string (required — summarized context from parent)"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "chatSessionId": "string",
  "parentSessionId": "string (original session ID)",
  "status": "pending",
  "forkDepth": 1,
  "initialPrompt": "string (context summary)",
  "createdAt": 1741651200000
}
```

**Errors:**
- 404: Session not found
- 409: Session not in terminal state (completed/failed/interrupted)
- 422: Fork depth exceeds `ACP_SESSION_MAX_FORK_DEPTH`

---

## GET `/api/projects/:projectId/acp-sessions/:sessionId/lineage`

Get the fork lineage tree for a session.

**Response (200):**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "parentSessionId": null,
      "status": "completed",
      "forkDepth": 0,
      "createdAt": 1741651200000
    },
    {
      "id": "uuid",
      "parentSessionId": "parent-uuid",
      "status": "running",
      "forkDepth": 1,
      "createdAt": 1741651300000
    }
  ]
}
```

---

## GET `/api/nodes/:nodeId/acp-sessions`

Reconciliation query for VM agent startup. Returns sessions assigned to this node.

**Query params:** `status=assigned,running` (comma-separated)

**Response (200):**
```json
{
  "sessions": [
    {
      "id": "uuid",
      "chatSessionId": "string",
      "workspaceId": "string",
      "status": "assigned",
      "initialPrompt": "string | null",
      "agentType": "string | null"
    }
  ]
}
```

**Auth:** Callback token (VM agent authenticates with its node callback token)

**Note:** This endpoint queries across projects. Implementation fans out to all ProjectData DOs that have sessions assigned to this node. To avoid fan-out, a D1 index `(node_id, status)` on the D1 projection table can be used.
