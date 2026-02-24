# Data Model: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Date**: 2026-02-24
**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

---

## Entity Relationship Overview

```
User ──1:N──> Project ──1:N──> Task
                │                 │
                │                 └──1:1──> ChatSession (via task_id)
                │                              │
                │                              └──1:N──> ChatMessage
                │
                ├──1:N──> Workspace ──1:1──> ChatSession (via workspace_id)
                │             │
                │             └──N:1──> Node
                │
                └──1:1──> NodeLifecycle (DO, per node)
```

---

## Storage Layer Mapping

| Entity | Storage | Rationale |
|---|---|---|
| Task | D1 (`tasks` table) | Cross-project queries, dashboard views |
| Node | D1 (`nodes` table) | Cross-project queries, admin views |
| Workspace | D1 (`workspaces` table) | Cross-project queries |
| Project | D1 (`projects` table) | Cross-project queries |
| ChatSession | ProjectData DO SQLite | Per-project write-heavy, real-time broadcast |
| ChatMessage | ProjectData DO SQLite | Per-project write-heavy, high volume |
| NodeLifecycle | NodeLifecycle DO storage | Per-node lifecycle coordination |
| MessageOutbox | VM Agent SQLite (local) | Crash-safe outbound queue |

---

## D1 Schema Changes

### Migration: `XXXX_add_project_default_vm_size.sql`

```sql
ALTER TABLE projects ADD COLUMN default_vm_size TEXT;
-- Nullable. NULL means use system default ('small').
-- Valid values: 'small', 'medium', 'large'
```

**Drizzle schema addition** (`apps/api/src/db/schema.ts`):
```typescript
// In projects table definition:
defaultVmSize: text('default_vm_size'),
```

### Migration: `XXXX_add_node_warm_since.sql`

```sql
ALTER TABLE nodes ADD COLUMN warm_since TEXT;
-- Nullable. ISO 8601 timestamp of when node became idle (no active workspaces).
-- Set when last workspace is destroyed; cleared when a workspace is created.
```

**Drizzle schema addition**:
```typescript
// In nodes table definition:
warmSince: text('warm_since'),
```

---

## ProjectData DO SQLite Changes

### Migration: Add `task_id` to `chat_sessions`

```sql
ALTER TABLE chat_sessions ADD COLUMN task_id TEXT;
CREATE INDEX idx_chat_sessions_task_id ON chat_sessions(task_id);
```

**Rationale**: Links a chat session to the task that triggered it. Nullable because manually-created workspaces also have chat sessions without a linked task.

### Updated `chat_sessions` Schema

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | ULID, shared with D1 agent_session for correlation |
| `workspace_id` | TEXT | Workspace that owns this session |
| `task_id` | TEXT (nullable) | **NEW** — Linked task ID (null for manual workspaces) |
| `topic` | TEXT (nullable) | Auto-captured from first user message |
| `status` | TEXT | 'active', 'stopped', 'error' |
| `message_count` | INTEGER | Running count of messages |
| `started_at` | INTEGER | Unix timestamp |
| `ended_at` | INTEGER (nullable) | Unix timestamp when stopped |
| `created_at` | INTEGER | Unix timestamp |
| `updated_at` | INTEGER | Unix timestamp |

### Existing `chat_messages` Schema (no changes)

| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | ULID |
| `session_id` | TEXT FK | References chat_sessions.id |
| `role` | TEXT | 'user', 'assistant', 'system', 'tool' |
| `content` | TEXT | Message content |
| `tool_metadata` | TEXT (nullable) | JSON: tool name, target, status |
| `created_at` | INTEGER | Unix timestamp |

---

## NodeLifecycle Durable Object (New)

### Purpose

Per-node lifecycle coordinator for warm pooling. Handles idle timeout scheduling and atomic node claiming for task reuse.

### Keying

```typescript
env.NODE_LIFECYCLE.idFromName(nodeId)
```

### Storage Schema

| Key | Type | Description |
|---|---|---|
| `nodeId` | string | Node identifier |
| `userId` | string | Owning user (for credential lookup during destruction) |
| `status` | string | 'active', 'warm', 'destroying' |
| `claimedByTask` | string (nullable) | Task ID that claimed this warm node |
| `warmSince` | string (nullable) | ISO 8601 timestamp |

### State Transitions

```
                ┌──────────────────────────┐
                │                          │
                v                          │
[active] ──workspace destroyed──> [warm] ──tryClaim()──> [active]
                                    │
                                    │ alarm fires (no claim)
                                    v
                               [destroying] ──cleanup done──> (DO deleted)
```

### Methods

| Method | Input | Output | Description |
|---|---|---|---|
| `markIdle(nodeId, userId)` | nodeId, userId | void | Set warm, schedule alarm |
| `markActive()` | — | void | Cancel alarm, set active |
| `tryClaim(taskId)` | taskId | boolean | Atomic claim attempt |
| `getStatus()` | — | { status, warmSince } | Read current state |
| `alarm()` | — (system callback) | void | Destroy node if still warm |

---

## VM Agent SQLite: Message Outbox (New Table)

### Purpose

Local crash-safe queue for outbound chat messages. Messages are written here before being sent to the control plane API.

### Schema

```sql
CREATE TABLE IF NOT EXISTS message_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_metadata TEXT,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_pending ON message_outbox(created_at ASC);
```

### Lifecycle

1. **Write**: `sessionHostClient.SessionUpdate()` extracts messages from `SessionNotification` and INSERTs into outbox
2. **Flush**: Background goroutine reads up to `MSG_BATCH_MAX_SIZE` oldest rows, POSTs to API
3. **Acknowledge**: On 200 response, DELETE sent rows from outbox
4. **Retry**: On failure, increment `attempts`, update `last_attempt_at`, backoff
5. **Discard**: On permanent error (4xx except 429), DELETE and log warning
6. **Shutdown**: Final flush attempt; remaining rows survive for next boot

### Size Limits

| Parameter | Default | Env Var |
|---|---|---|
| Max outbox rows | 10,000 | `MSG_OUTBOX_MAX_SIZE` |

When limit is reached, oldest messages are dropped with a warning log.

---

## Cloud-Init Variables Extension

### Current `CloudInitVariables` Interface

```typescript
interface CloudInitVariables {
  nodeId: string;
  hostname: string;
  controlPlaneUrl: string;
  jwksUrl: string;
  callbackToken: string;
  logJournalMaxUse?: string;
  logJournalKeepFree?: string;
  logJournalMaxRetention?: string;
}
```

### Extended Interface

```typescript
interface CloudInitVariables {
  // ... existing fields ...
  projectId?: string;        // NEW — Project context for message persistence
  chatSessionId?: string;    // NEW — Pre-created chat session ID
}
```

### VM Agent Environment Variables (systemd service)

| Variable | Source | Description |
|---|---|---|
| `NODE_ID` | existing | Node identifier |
| `CONTROL_PLANE_URL` | existing | API base URL |
| `JWKS_ENDPOINT` | existing | JWKS URL for token validation |
| `CALLBACK_TOKEN` | existing | Callback JWT for API auth |
| `PROJECT_ID` | **new** | Project ID for message persistence (nullable) |
| `CHAT_SESSION_ID` | **new** | Pre-created chat session ID (nullable) |

---

## Shared Type Additions

### `PersistMessageBatchRequest` (new)

```typescript
interface PersistMessageBatchRequest {
  messages: PersistMessageItem[];
}

interface PersistMessageItem {
  messageId: string;         // UUID v4, idempotency key
  sessionId: string;         // Chat session ID
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolMetadata?: {
    tool: string;
    target: string;
    status: 'success' | 'error';
  } | null;
  timestamp: string;         // ISO 8601
}
```

### `PersistMessageBatchResponse` (new)

```typescript
interface PersistMessageBatchResponse {
  persisted: number;
  duplicates: number;
}
```

### `NodeLifecycleStatus` (new)

```typescript
type NodeLifecycleStatus = 'active' | 'warm' | 'destroying';

interface NodeLifecycleState {
  nodeId: string;
  status: NodeLifecycleStatus;
  warmSince: string | null;
  claimedByTask: string | null;
}
```

### `UpdateProjectRequest` Extension

```typescript
interface UpdateProjectRequest {
  // ... existing fields ...
  defaultVmSize?: VMSize | null;  // Already exists in shared types
}
```

---

## Configuration Values (Principle XI Compliance)

All new configurable values with defaults:

### VM Agent (Go)

| Env Var | Default | Description |
|---|---|---|
| `MSG_BATCH_MAX_WAIT_MS` | `2000` | Max time between flush cycles |
| `MSG_BATCH_MAX_SIZE` | `50` | Max messages per batch |
| `MSG_BATCH_MAX_BYTES` | `65536` | Max batch payload size |
| `MSG_OUTBOX_MAX_SIZE` | `10000` | Max pending messages in outbox |
| `MSG_RETRY_INITIAL_INTERVAL_MS` | `1000` | Initial retry backoff |
| `MSG_RETRY_MAX_INTERVAL_MS` | `30000` | Maximum retry backoff |
| `MSG_RETRY_MAX_ELAPSED_TIME_MS` | `300000` | Max total retry time per batch |

### Control Plane (Cloudflare Worker)

| Env Var | Default | Description |
|---|---|---|
| `NODE_WARM_TIMEOUT_MS` | `1800000` | Warm node idle timeout (30 min) |
| `MAX_AUTO_NODE_LIFETIME_MS` | `14400000` | Max auto-provisioned node lifetime (4 hr) |
| `NODE_CLEANUP_SWEEP_INTERVAL_CRON` | `*/15 * * * *` | Reconciliation sweep interval |
| `NODE_CLEANUP_GRACE_PERIOD_MS` | `2700000` | Extra grace period for sweep (45 min total) |

---

## Validation Rules

### Chat Session Creation
- `workspace_id` must reference a valid workspace
- `task_id` must reference a valid task in the same project (if provided)
- Only one active session per task (enforced at creation time)

### Message Persistence
- `message_id` must be unique per session (UNIQUE constraint, idempotent)
- `role` must be one of: 'user', 'assistant', 'system', 'tool'
- `content` must not be empty
- `session_id` must reference an existing session in the same project

### Node Lifecycle
- Only auto-provisioned nodes can enter 'warm' state
- `tryClaim()` only succeeds if status is 'warm'
- Alarm only destroys if status is still 'warm' at fire time
- Max lifetime applies regardless of status

### Project Default VM Size
- Must be one of: 'small', 'medium', 'large', or null (system default)
- Task run uses project default if no override specified
