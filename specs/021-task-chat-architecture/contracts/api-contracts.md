# API Contracts: Task-Driven Chat Architecture

**Date**: 2026-02-24
**Spec**: [spec.md](../spec.md) | **Data Model**: [data-model.md](../data-model.md)

---

## New Endpoints

### 1. POST `/api/workspaces/:workspaceId/messages` (VM Agent → Control Plane)

Batch persist chat messages from the VM agent to the ProjectData Durable Object.

**Authentication**: Callback JWT (`workspace-callback` audience)

**Headers**:
```
Authorization: Bearer <callback-jwt>
Content-Type: application/json
```

**Path Parameters**:
| Parameter | Type | Description |
|---|---|---|
| `workspaceId` | string | Workspace identifier (must match JWT `workspace` claim) |

**Request Body**:
```json
{
  "messages": [
    {
      "messageId": "550e8400-e29b-41d4-a716-446655440000",
      "sessionId": "01HXYZ...",
      "role": "assistant",
      "content": "I'll help you implement that feature.",
      "toolMetadata": null,
      "timestamp": "2026-02-24T12:00:00.000Z"
    },
    {
      "messageId": "550e8400-e29b-41d4-a716-446655440001",
      "sessionId": "01HXYZ...",
      "role": "tool",
      "content": "File written successfully.",
      "toolMetadata": {
        "tool": "Write",
        "target": "src/main.ts",
        "status": "success"
      },
      "timestamp": "2026-02-24T12:00:01.000Z"
    }
  ]
}
```

**Validation**:
- `messages` array: 1-100 items
- `messageId`: UUID v4 format, unique per session
- `sessionId`: must reference existing session in the workspace's project
- `role`: one of 'user', 'assistant', 'system', 'tool'
- `content`: non-empty string
- `timestamp`: ISO 8601 format
- Total payload: max 256 KB

**Success Response** (200):
```json
{
  "persisted": 2,
  "duplicates": 0
}
```

**Error Responses**:
| Status | Error | When |
|---|---|---|
| 400 | `invalid_request` | Validation failure (malformed body, invalid role, etc.) |
| 401 | `unauthorized` | Missing or invalid callback JWT |
| 403 | `forbidden` | JWT workspace claim doesn't match path |
| 404 | `session_not_found` | Session ID doesn't exist in project |
| 413 | `payload_too_large` | Payload exceeds 256 KB |

**Idempotency**: Duplicate `messageId` values are silently skipped (counted in `duplicates`).

**Side Effects**:
- Each message persisted triggers WebSocket broadcast (`message.new`) to connected project viewers
- Session `message_count` and `updated_at` are updated
- Topic auto-captured from first user message (if not set)

---

### 2. NodeLifecycle Durable Object RPC

Internal RPC methods called by the API worker. Not exposed as HTTP endpoints.

#### `markIdle(nodeId: string, userId: string): Promise<void>`

Transition node to warm state and schedule cleanup alarm.

**Preconditions**: Node has no active workspaces
**Effects**:
- Sets status = 'warm', stores nodeId, userId
- Schedules alarm at `Date.now() + NODE_WARM_TIMEOUT_MS`
- Updates D1 node record: `warm_since` = now

**Errors**:
- If already warm: no-op (alarm reset to new timeout)
- If destroying: throws `node_lifecycle_conflict`

#### `markActive(): Promise<void>`

Transition node back to active state, cancelling any pending alarm.

**Effects**:
- Sets status = 'active', clears claimedByTask
- Cancels pending alarm via `deleteAlarm()`
- Updates D1 node record: `warm_since` = null

#### `tryClaim(taskId: string): Promise<boolean>`

Atomically attempt to claim a warm node for a task.

**Returns**: `true` if claim succeeded, `false` if node was not warm

**Effects (on success)**:
- Sets status = 'active', claimedByTask = taskId
- Cancels pending alarm
- Updates D1 node record: `warm_since` = null

**Effects (on failure)**: None

#### `getStatus(): Promise<NodeLifecycleState>`

Read current lifecycle state.

**Returns**:
```typescript
{
  nodeId: string;
  status: 'active' | 'warm' | 'destroying';
  warmSince: string | null;
  claimedByTask: string | null;
}
```

#### `alarm(): Promise<void>` (system callback)

Fires when warm timeout expires.

**Effects**:
- If status !== 'warm': no-op (node was claimed)
- If status === 'warm': set status = 'destroying', initiate node cleanup
  - Fetch user credentials from D1
  - Delete Hetzner server
  - Delete DNS record
  - Update D1 node record: status = 'stopped'
  - Delete all DO storage

**Error Handling**:
- On failure: schedule retry alarm (1 minute), log error
- After 6 retries: log critical error, rely on cron sweep

---

## Modified Endpoints

### 3. POST `/api/projects/:projectId/tasks/:taskId/run` (Enhanced)

**Existing behavior preserved.** New behavior additions:

**New in request flow**:
1. After workspace creation, before scheduling on node:
   - Create chat session in ProjectData DO: `createSession(workspaceId, task.title, taskId)`
   - Include `chatSessionId` in cloud-init variables
2. Set `output_branch` to `task/{taskId}` format during task execution setup
3. Use project's `default_vm_size` if no `vmSize` in request body and no `nodeId` specified

**New in completion flow** (task callback indicating clean completion):
1. Auto-destroy workspace via `stopWorkspaceOnNode()`
2. Check if node has remaining active workspaces
3. If no workspaces: call `NodeLifecycle.markIdle(nodeId, userId)`
4. If workspaces remain: no change to node lifecycle

**New in failure flow** (task callback indicating error/failure):
1. Keep workspace alive (do NOT destroy)
2. Do NOT transition node to warm state
3. Update task status to 'failed' with error message

---

### 4. POST `/api/workspaces` (Enhanced)

**Existing behavior preserved.** New behavior addition:

**New step after workspace record creation**:
- If `projectId` is set on the workspace:
  1. Create chat session in ProjectData DO: `createSession(workspaceId, null, null)`
  2. Include `chatSessionId` in cloud-init variables passed to node agent

**No change** if `projectId` is null (standalone workspace, no chat persistence).

---

### 5. GET `/api/projects/:projectId/sessions` (Enhanced)

**Existing behavior preserved.** New query parameter:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `taskId` | string (optional) | — | Filter sessions by linked task ID |

**Response**: Same format, filtered to sessions where `task_id` matches.

---

### 6. PATCH `/api/projects/:projectId` (Enhanced)

**Existing behavior preserved.** New field:

| Field | Type | Description |
|---|---|---|
| `defaultVmSize` | VMSize or null | Default VM size for task runs |

---

## Cron Trigger Contract

### Node Cleanup Reconciliation Sweep

**Trigger**: Cron schedule (default: `*/15 * * * *` — every 15 minutes)

**Behavior**:
1. Query D1 for nodes where:
   - `status = 'running'`
   - `warm_since IS NOT NULL`
   - `warm_since < (now - NODE_CLEANUP_GRACE_PERIOD_MS)`
2. For each stale node:
   - Verify no active workspaces in D1
   - If confirmed empty: initiate node destruction (same flow as DO alarm)
3. Query D1 for auto-provisioned nodes where:
   - `created_at < (now - MAX_AUTO_NODE_LIFETIME_MS)`
   - `status IN ('running', 'warm')`
4. For each over-limit node:
   - Warn user (log, potentially future notification)
   - Initiate node destruction

**Idempotency**: Safe to run multiple times. Checks current state before acting.

---

## WebSocket Contract (ProjectData DO)

### Existing Behavior (preserved)

The ProjectData DO already supports Hibernatable WebSocket connections at `/ws`. Connected clients receive broadcasts for activity events.

### New Broadcast Events

#### `message.new`

Sent when a new chat message is persisted (from VM agent batch endpoint).

```json
{
  "type": "message.new",
  "sessionId": "01HXYZ...",
  "message": {
    "id": "msg-id",
    "role": "assistant",
    "content": "...",
    "toolMetadata": null,
    "createdAt": 1708776000000
  }
}
```

**Note**: This event already exists in the current ProjectData DO implementation. No change needed — the `persistMessage()` method already broadcasts `message.new` events.

#### `session.created`

Sent when a new chat session is created (for task runs or manual workspaces).

```json
{
  "type": "session.created",
  "session": {
    "id": "01HXYZ...",
    "workspaceId": "ws-abc",
    "taskId": "task-123",
    "topic": "Implement user authentication",
    "status": "active",
    "messageCount": 0,
    "createdAt": 1708776000000
  }
}
```

#### `session.stopped`

Sent when a chat session is stopped (workspace destroyed or manually stopped).

```json
{
  "type": "session.stopped",
  "sessionId": "01HXYZ...",
  "endedAt": 1708779600000
}
```

---

## Go VM Agent Interfaces

### MessageReporter

```go
package messagereport

type Config struct {
    APIBaseURL      string        // From CONTROL_PLANE_URL
    WorkspaceID     string        // From workspace context
    ProjectID       string        // From PROJECT_ID env var
    SessionID       string        // From CHAT_SESSION_ID env var
    AuthToken       string        // From callback JWT
    BatchMaxWait    time.Duration // From MSG_BATCH_MAX_WAIT_MS
    BatchMaxSize    int           // From MSG_BATCH_MAX_SIZE
    BatchMaxBytes   int           // From MSG_BATCH_MAX_BYTES
    OutboxMaxSize   int           // From MSG_OUTBOX_MAX_SIZE
    RetryInitial    time.Duration // From MSG_RETRY_INITIAL_INTERVAL_MS
    RetryMax        time.Duration // From MSG_RETRY_MAX_INTERVAL_MS
    RetryMaxElapsed time.Duration // From MSG_RETRY_MAX_ELAPSED_TIME_MS
    DB              *sql.DB       // Existing SQLite database
    Logger          *slog.Logger
}

type Reporter struct { /* internal */ }

func New(cfg Config) (*Reporter, error)

// Enqueue adds a message to the outbox for async delivery.
// Non-blocking. Returns error only if outbox is full.
func (r *Reporter) Enqueue(msg Message) error

// SetToken updates the auth token (called after bootstrap).
func (r *Reporter) SetToken(token string)

// Shutdown flushes remaining messages and waits for completion.
func (r *Reporter) Shutdown(ctx context.Context) error

type Message struct {
    MessageID    string
    Role         string
    Content      string
    ToolMetadata *ToolMetadata // nullable
    Timestamp    time.Time
}

type ToolMetadata struct {
    Tool   string `json:"tool"`
    Target string `json:"target"`
    Status string `json:"status"`
}
```

### Integration Point

In `sessionHostClient.SessionUpdate()`:

```go
func (c *sessionHostClient) SessionUpdate(_ context.Context, params acpsdk.SessionNotification) error {
    // Existing: broadcast to viewers
    data, err := json.Marshal(...)
    c.host.broadcastMessage(data)

    // NEW: enqueue for persistence (if reporter configured)
    if c.host.messageReporter != nil {
        for _, msg := range extractMessages(params) {
            if err := c.host.messageReporter.Enqueue(msg); err != nil {
                slog.Warn("message outbox full, dropping message", "error", err)
            }
        }
    }

    return nil
}
```
