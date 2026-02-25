# Contract: Enhanced Session API Responses

**Endpoints**: Multiple session-related endpoints with enhanced response types
**Purpose**: Add computed lifecycle fields to session responses for frontend rendering of active/idle/terminated states.
**Research Reference**: R7 (Session State Derivation), R8 (User Message Relay)

## Enhanced Response Types

### ChatSessionResponse (list endpoint)

**Endpoint**: `GET /api/projects/:projectId/chat/sessions`

```json
{
  "sessions": [
    {
      "id": "sess_01JK9M2X4N...",
      "workspaceId": "ws-abc123",
      "taskId": "01JK9M2X4N...",
      "topic": "Add input validation to signup form",
      "status": "active",
      "messageCount": 24,
      "startedAt": 1740000000000,
      "endedAt": null,
      "createdAt": 1740000000000,
      "agentCompletedAt": 1740001800000,

      "isIdle": true,
      "isTerminated": false,
      "workspaceUrl": "https://ws-abc123.example.com"
    },
    {
      "id": "sess_01JK8...",
      "workspaceId": "ws-def456",
      "taskId": "01JK8...",
      "topic": "Fix login timeout bug",
      "status": "stopped",
      "messageCount": 15,
      "startedAt": 1739900000000,
      "endedAt": 1739910000000,
      "createdAt": 1739900000000,
      "agentCompletedAt": 1739909000000,

      "isIdle": false,
      "isTerminated": true,
      "workspaceUrl": null
    }
  ],
  "nextCursor": "..."
}
```

### New/Modified Fields

| Field | Type | Stored | Derivation |
|-------|------|--------|------------|
| `agentCompletedAt` | number \| null | Yes (DO SQLite) | Stored when agent completion callback received |
| `isIdle` | boolean | No (computed) | `status === 'active' && agentCompletedAt != null` |
| `isTerminated` | boolean | No (computed) | `status === 'stopped'` |
| `workspaceUrl` | string \| null | No (computed) | `workspaceId ? \`https://ws-${workspaceId}.${BASE_DOMAIN}\` : null` |

### ChatSessionDetailResponse (single session endpoint)

**Endpoint**: `GET /api/projects/:projectId/chat/sessions/:sessionId`

Same fields as list response, plus existing message-related fields. Additionally:

```json
{
  "...all ChatSessionResponse fields...",
  "messages": [...],
  "task": {
    "id": "01JK9M2X4N...",
    "status": "running",
    "executionStep": "awaiting_followup",
    "outputBranch": "sam/add-input-validation-01jk9m",
    "outputPrUrl": "https://github.com/user/repo/pull/42",
    "finalizedAt": "2026-02-25T10:30:00.000Z"
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `task` | object \| null | Embedded task summary when session is linked to a task. Includes fields needed for session header display (branch name, PR link, status). |

**Note**: The `task` field requires a D1 lookup since task data lives in D1, not the DO. This is acceptable for the detail endpoint (single session) but NOT for the list endpoint (would require N+1 queries). The list endpoint only includes DO-local fields.

## Frontend Usage

### Session Sidebar Rendering

```typescript
function getSessionIndicator(session: ChatSessionResponse) {
  if (session.isTerminated) {
    return { color: 'gray', label: 'Ended', inputEnabled: false };
  }
  if (session.isIdle) {
    return { color: 'amber', label: 'Agent finished', inputEnabled: true };
  }
  // Active and agent working
  return { color: 'green', label: 'Active', inputEnabled: true };
}
```

### Message Input Behavior

| Session State | Input Visible | Placeholder | Behavior |
|---------------|---------------|-------------|----------|
| Active (agent working) | Yes | "Send a message..." | Send via WebSocket to VM agent |
| Idle (agent finished) | Yes | "Send a follow-up to the agent..." | Send via WebSocket, reset idle timer |
| Terminated | No (replaced) | — | Show "Start a new chat" button |

### WebSocket Connection Logic

```typescript
// When viewing an active/idle session with a workspaceId:
if (session.status === 'active' && session.workspaceId) {
  // Connect directly to VM agent WebSocket
  const ws = new WebSocket(
    `wss://ws-${session.workspaceId}.${BASE_DOMAIN}/acp/${acpSessionId}`
  );
  // User messages flow through this WebSocket
  // Agent responses come through this WebSocket AND via DO broadcast
}

// When session is terminated or has no workspace:
// Use read-only mode, load messages via REST API
```

## Idle Timer Reset Endpoint

**Endpoint**: `POST /api/projects/:projectId/sessions/:sessionId/idle-reset`

**Purpose**: Reset the idle cleanup timer when the user sends a follow-up message. Called by the frontend when a message is sent to an idle session.

### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| — | — | — | No body required. Session ID from path. |

### Headers

- `Cookie`: Session cookie (standard auth)

### Response

#### 200 OK

```json
{
  "success": true,
  "newCleanupAt": "2026-02-25T10:45:00.000Z"
}
```

#### Error Responses

| Status | Code | When |
|--------|------|------|
| 404 | `SESSION_NOT_FOUND` | Session doesn't exist in this project |
| 409 | `SESSION_NOT_IDLE` | Session has no pending idle cleanup timer |

### Server-Side Logic

```
1. Validate auth + project ownership
2. Call ProjectData DO: resetIdleCleanup(sessionId)
   - Update cleanup_at = now + SESSION_IDLE_TIMEOUT_MINUTES
   - Recalculate DO alarm to MIN(cleanup_at)
3. Optionally: Clear agentCompletedAt on chat session (if agent resumes)
4. Return new cleanup timestamp
```

## Notes

- The `workspaceUrl` field uses `BASE_DOMAIN` from the environment, ensuring no hardcoded URLs (Principle XI).
- Computed fields are calculated in the DO's RPC handler before returning to the API worker. This keeps computation close to the data.
- The task embed in the detail response is optional — if the D1 lookup fails, the response still returns with `task: null`.
