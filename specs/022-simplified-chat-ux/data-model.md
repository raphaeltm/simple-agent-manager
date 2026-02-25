# Data Model: Simplified Chat-First UX

**Feature Branch**: `022-simplified-chat-ux`
**Date**: 2026-02-25
**Spec**: [spec.md](./spec.md) | **Research**: [research.md](./research.md)

## Overview

This feature primarily reshapes the UI layer. Data model changes are minimal and focused on three areas:

1. **Task finalization guard** — idempotent git push + PR creation (R10)
2. **Idle cleanup scheduling** — DO-based timer for workspace cleanup after agent completion (R3)
3. **Enhanced API responses** — computed session lifecycle fields for frontend (R7)

No new tables in D1. No new entity types. Changes extend existing entities.

---

## D1 Schema Changes

### tasks table

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `finalized_at` | TEXT (nullable) | NULL | ISO 8601 timestamp. Set on first successful git push + PR creation. Guards against duplicate finalization from concurrent agent completion and idle cleanup paths. |

**Migration**:
```sql
ALTER TABLE tasks ADD COLUMN finalized_at TEXT;
```

**Behavior**:
- Set by the status callback endpoint when `gitPushResult.pushed === true` and `finalized_at IS NULL`
- Checked before any git push or PR creation operation — skip if already set
- Queryable: `SELECT * FROM tasks WHERE finalized_at IS NOT NULL` for reporting

### Existing columns used with new semantics

| Column | Existing Type | New Usage |
|--------|---------------|-----------|
| `output_branch` | TEXT (nullable) | Populated at task creation time (submit endpoint) with generated branch name instead of during workspace creation |
| `execution_step` | TEXT (nullable) | New value `'awaiting_followup'` added to track agent-complete-but-session-active state |

### execution_step values (updated)

```
node_selection → node_provisioning → node_agent_ready →
workspace_creation → workspace_ready → agent_session →
running → awaiting_followup (NEW)
```

The `awaiting_followup` step indicates:
- Agent ACP session has ended
- Git push has been attempted (result stored)
- Workspace is still alive
- Idle cleanup timer is running
- User can send follow-up messages

---

## ProjectData DO Schema Changes

### chat_sessions table (modified)

| Column | Type | Default | Description |
|--------|------|---------|-------------|
| `agent_completed_at` | TEXT (nullable) | NULL | ISO 8601 timestamp. Set when agent completion signal received. Used as reference for idle timeout calculation. Distinct from `updated_at` which changes on any update. |

**Migration** (DO SQLite auto-migration in init SQL):
```sql
-- Add column if not exists (DO SQLite migration pattern)
ALTER TABLE chat_sessions ADD COLUMN agent_completed_at TEXT;
```

The DO constructor should check for this column and add it if missing, following the same pattern used for other DO schema evolution.

### idle_cleanup_schedule table (new)

```sql
CREATE TABLE IF NOT EXISTS idle_cleanup_schedule (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  cleanup_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Purpose**: Tracks which sessions have pending idle cleanup timers. The DO alarm fires at the earliest `cleanup_at` time.

**Operations**:
- **Schedule**: Insert/replace when agent completion signal received
- **Reset**: Update `cleanup_at` when user sends follow-up message
- **Fire**: When alarm triggers, find all rows where `cleanup_at <= now`, trigger cleanup for each
- **Cancel**: Delete row when session manually stopped or workspace explicitly destroyed
- **Recalculate alarm**: After any write, set DO alarm to `MIN(cleanup_at)` across all rows

**Alarm pattern** (mirrors NodeLifecycle DO):
```
scheduleIdleCleanup(sessionId, workspaceId, taskId) {
  1. Insert/update idle_cleanup_schedule
  2. Find MIN(cleanup_at) across all scheduled sessions
  3. Set DO alarm to that timestamp
}

cancelIdleCleanup(sessionId) {
  1. Delete from idle_cleanup_schedule WHERE session_id = ?
  2. If remaining rows: set alarm to MIN(cleanup_at)
  3. If no rows: delete alarm
}

alarm() {
  1. Find all rows WHERE cleanup_at <= now
  2. For each: call internal cleanup method
  3. Delete fired rows
  4. If remaining: set alarm to next MIN(cleanup_at)
}
```

---

## Entity Updates

### Task (extended)

```typescript
interface Task {
  // Existing fields (unchanged)
  id: string;
  projectId: string;
  userId: string;
  parentTaskId: string | null;
  workspaceId: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  executionStep: TaskExecutionStep | null;
  priority: number;
  agentProfileHint: string | null;
  blocked: boolean;
  autoProvisionedNodeId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  outputSummary: string | null;
  outputBranch: string | null;
  outputPrUrl: string | null;
  createdAt: string;
  updatedAt: string;

  // New field
  finalizedAt: string | null;  // ISO 8601, set on successful git push + PR
}

// Existing — no changes to allowed values
type TaskStatus = 'draft' | 'pending' | 'queued' | 'running' |
  'paused' | 'completed' | 'failed' | 'cancelled';

// Extended with new value
type TaskExecutionStep =
  | 'node_selection'
  | 'node_provisioning'
  | 'node_agent_ready'
  | 'workspace_creation'
  | 'workspace_ready'
  | 'agent_session'
  | 'running'
  | 'awaiting_followup';  // NEW
```

### ChatSession (extended response)

```typescript
interface ChatSessionResponse {
  // Existing fields
  id: string;
  workspaceId: string | null;
  taskId: string | null;
  topic: string | null;
  status: 'active' | 'stopped';
  messageCount: number;
  startedAt: number;
  endedAt: number | null;
  createdAt: number;
  agentCompletedAt: number | null;  // NEW: stored field

  // Computed fields (NOT stored, derived at query time)
  isIdle: boolean;       // true when agentCompletedAt != null AND status == 'active'
  isTerminated: boolean; // true when status == 'stopped'
  workspaceUrl: string | null; // derived from workspaceId + BASE_DOMAIN
}
```

**isIdle derivation logic**:
```typescript
const isIdle = session.status === 'active'
  && session.agentCompletedAt != null;

const isTerminated = session.status === 'stopped';
```

Note: We intentionally do NOT use a time-based check for `isIdle`. The `agentCompletedAt` field serves as a binary signal. The actual idle countdown is managed by the DO alarm, not computed at query time. This avoids clock drift issues between query time and alarm time.

---

## State Machines

### Task Lifecycle (chat-first flow)

```
[submit endpoint]
       │
       v
    queued ──executeTaskRun──> delegated ──> in_progress
                                                │
                                     ┌──────────┴──────────┐
                                     │                      │
                               running              awaiting_followup
                            (agent working)        (agent done, session live)
                                     │                      │
                                     │              ┌───────┴───────┐
                                     │              │               │
                                     │        user follow-up   idle timeout
                                     │         (→ running)      (→ completed)
                                     │              │               │
                                     v              v               v
                                  failed ←────── completed ←────────┘
                                     │
                                     v
                                 cancelled
```

**Key transitions**:
- `running → awaiting_followup`: Agent ACP session ends, git push attempted
- `awaiting_followup → running`: User sends follow-up message (implicit via WebSocket activity)
- `awaiting_followup → completed`: Idle timeout fires, workspace cleaned up
- Any active state → `failed`: Error during execution
- Any active state → `cancelled`: User cancels

### Session Lifecycle (user-facing states)

```
  active (green)
  ├── agent working: messages streaming, cancel button available
  └── agent idle: agent finished, input shows "Send a follow-up..."
       │
       │ idle timeout OR manual stop
       v
  terminated (gray)
  └── read-only: full history visible, input disabled
      "Start a new chat" prompt shown
```

The frontend derives visual state from:
- `status === 'active' && !isIdle` → active (agent working)
- `status === 'active' && isIdle` → active but idle (amber indicator)
- `status === 'stopped'` → terminated (gray)

---

## Configuration Parameters

All values follow Principle XI (No Hardcoded Values).

### New Parameters

| Env Var | Default | Type | Description |
|---------|---------|------|-------------|
| `SESSION_IDLE_TIMEOUT_MINUTES` | `15` | integer | Minutes after agent completion before auto-cleanup. Already declared in wrangler.toml but unused. |
| `BRANCH_NAME_MAX_LENGTH` | `60` | integer | Maximum character length for generated branch names |
| `BRANCH_NAME_PREFIX` | `sam/` | string | Prefix for platform-generated branch names |
| `IDLE_CLEANUP_RETRY_DELAY_MS` | `300000` (5 min) | integer | Grace period before retry if idle cleanup fails |
| `IDLE_CLEANUP_MAX_RETRIES` | `1` | integer | Maximum retry attempts for failed idle cleanup |

### Existing Parameters (now used)

| Env Var | Default | Current Status |
|---------|---------|----------------|
| `SESSION_IDLE_TIMEOUT_MINUTES` | `15` | Declared in wrangler.toml but unused → now drives idle cleanup alarm |

---

## Validation Rules

| Rule | Enforcement | Details |
|------|-------------|---------|
| **Finalization idempotency** | Application logic | Check `finalizedAt IS NULL` before git push/PR operations |
| **Branch name format** | Submit endpoint validation | Must match `^[a-z0-9/_-]+$`, max length from config |
| **Branch name uniqueness** | Task ID suffix | Short task ID appended guarantees uniqueness (R6) |
| **Idle timer ownership** | DO isolation | Only the project's DO manages its session idle timers |
| **Execution step transitions** | Application logic | `awaiting_followup` only reachable from `running` |
| **Session computed fields** | Read-only | `isIdle`, `isTerminated`, `workspaceUrl` are never stored |

---

## Impact on Existing Data

### Backward Compatibility

- `finalizedAt` column is nullable — existing tasks unaffected
- `agent_completed_at` column is nullable — existing sessions unaffected
- `idle_cleanup_schedule` table is new — no existing data to migrate
- `awaiting_followup` execution step — existing task runner code ignores unknown step values
- Computed response fields (`isIdle`, `isTerminated`) are additive — existing API consumers can ignore them

### No Breaking Changes

All changes are additive. No existing columns removed, no type changes, no constraint changes. Frontend changes are purely in the rendering layer and route structure.
