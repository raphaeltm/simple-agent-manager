# Workspace Lifecycle — Exhaustive Code Path Trace

Last Updated: 2026-03-16

This document traces every code path that affects workspace lifecycle: creation, status changes, activity tracking, idle detection, cleanup, and UI display. It serves as a reference for debugging workspace lifecycle issues and as a map for future fixes.

---

## Table of Contents

1. [Status Definitions](#1-status-definitions)
2. [Creation Paths](#2-creation-paths)
3. [Status Transitions](#3-status-transitions)
4. [Activity Tracking System](#4-activity-tracking-system)
5. [Idle Detection & Timeout](#5-idle-detection--timeout)
6. [Chat Session Lifecycle](#6-chat-session-lifecycle)
7. [Node Cleanup & VM Destruction](#7-node-cleanup--vm-destruction)
8. [Chat UI Status Display](#8-chat-ui-status-display)
9. [Known Bugs & Gaps](#9-known-bugs--gaps)
10. [Quick Reference: Who Stops What](#10-quick-reference-who-stops-what)

---

## 1. Status Definitions

### Workspace Statuses (D1 `workspaces.status`)

| Status | Meaning | Set By |
|--------|---------|--------|
| `creating` | VM provisioning in progress | Workspace creation, restart, rebuild |
| `running` | VM ready, agent can execute | VM agent `/ready` callback |
| `recovery` | VM recovered from crash | VM agent `/ready` callback |
| `stopping` | Stop in progress (transient) | `POST /workspaces/:id/stop` |
| `stopped` | VM stopped, eligible for cleanup | Stop route, idle timeout, task cleanup |
| `error` | Permanent failure | Provisioning timeout, stop failure, agent error |
| `deleted` | Node destroyed, cascade | Node cleanup cron |

### Chat Session Statuses (ProjectData DO SQLite `chat_sessions.status`)

| Status | Meaning | Set By |
|--------|---------|--------|
| `active` | Session is live | `createSession()` |
| `stopped` | Session has ended | `stopSessionInternal()`, `stopSession()` |

---

## 2. Creation Paths

### Path A: User-Initiated (`POST /api/workspaces`)

**Entrypoint:** `apps/api/src/routes/workspaces/crud.ts:114`

1. Validate `name` + `projectId` (required) — line 130-167
2. Select or provision node — line 170-204
3. Insert workspace into D1 with `status='creating'` — line 226-242
4. Create chat session in ProjectData DO via `createSession(workspaceId)` — line 245-259
   - Inserts `chat_sessions` row with `status='active'` — `project-data.ts:118-128`
   - **Inserts `workspace_activity` row** (because `workspaceId` is non-null) — `project-data.ts:131-139`
   - **Schedules DO alarm** via `recalculateAlarm()` — `project-data.ts:141`
5. Update workspace with `chatSessionId` in D1 — line 252-255
6. Background: provision node, create workspace on VM agent — lines 292-347

**State created:**
- D1 `workspaces`: status=`creating`, projectId set, chatSessionId set
- DO `chat_sessions`: status=`active`, workspace_id set
- DO `workspace_activity`: row exists, `last_message_at` = now
- DO alarm: scheduled

### Path B: Task-Driven (`POST /api/projects/:id/tasks/submit`)

**Entrypoint:** `apps/api/src/routes/tasks/submit.ts:51`

1. Create task record in D1 with `status='queued'` — line 192-219
2. Create chat session in ProjectData DO via `createSession(workspaceId=null)` — line 224-258
   - Inserts `chat_sessions` row with `status='active'`, `workspace_id=NULL`
   - **Does NOT insert `workspace_activity` row** (guarded by `if (workspaceId)`) — `project-data.ts:131`
   - **Does NOT schedule alarm for workspace idle checks** — `project-data.ts:141`
3. TaskRunner DO creates workspace later — `task-runner.ts:566-676`
4. `ensureSessionLinked()` links session to workspace — `task-runner.ts:925-989`
   - Calls `linkSessionToWorkspace()` in DO — `project-data.ts:412-433`
   - Updates `chat_sessions.workspace_id` in DO SQLite — `project-data.ts:425-430`
   - **Does NOT create `workspace_activity` row** — `project-data.ts:412-433` (no INSERT)
   - **Does NOT schedule alarm** — no `recalculateAlarm()` call

**State created:**
- D1 `workspaces`: status=`creating`, projectId set, chatSessionId set
- DO `chat_sessions`: status=`active`, workspace_id set (after linking)
- DO `workspace_activity`: **NO ROW** (until messages flow or terminal activity happens)
- DO alarm: **NOT SCHEDULED** for workspace idle checks (may be scheduled for other reasons like ACP heartbeats)

### Path B Eventual Activity Tracking

After `linkSessionToWorkspace()`, messages start flowing:
- `persistMessage()` → `updateMessageActivity()` — `project-data.ts:251-257`
- This does an `INSERT ... ON CONFLICT` upsert, creating the `workspace_activity` row
- **But `updateMessageActivity()` does NOT call `recalculateAlarm()`** — `project-data.ts:1074-1087`
- The alarm may eventually fire for other reasons (ACP heartbeat, idle cleanup schedule) and pick up the workspace_activity rows in its idle check

---

## 3. Status Transitions

### Full Status Transition Map

```
                 ┌──────────────────────────┐
                 │                          │
                 ▼                          │
            ┌─────────┐   VM callback   ┌───────┐
    ───────▶│ creating │───────────────▶│running │
            └─────────┘                 └───────┘
                 │                         │  │
                 │ error                   │  │ stop (user)
                 ▼                         │  ▼
            ┌─────────┐                    │ ┌────────┐
            │  error   │◀──────────────────┘ │stopping│
            └─────────┘   stop/rebuild fail  └────────┘
                 │                              │
                 │ restart                      │ success
                 ▼                              ▼
            ┌─────────┐                    ┌───────┐
            │ creating │                   │stopped│
            └─────────┘                    └───────┘
                                               │
                                               │ node destroyed
                                               ▼
                                          ┌───────┐
                                          │deleted│
                                          └───────┘
```

### All Transition Triggers

| From | To | Trigger | Code Path |
|------|----|---------|-----------|
| — | `creating` | User creates workspace | `crud.ts:237` |
| — | `creating` | Task runner creates workspace | `task-runner.ts:608-651` |
| `creating` | `running` | VM agent signals ready | `lifecycle.ts:219` |
| `creating` | `recovery` | VM agent signals recovery | `lifecycle.ts:219` |
| `creating` | `error` | Provisioning timeout (30 min) | `timeout.ts:80-87` |
| `creating` | `error` | VM signals provisioning failure | `lifecycle.ts:273-281` |
| `creating` | `error` | Node provisioning fails | `crud.ts:309-316` |
| `creating` | `error` | Node agent unreachable | `crud.ts:323-331` |
| `running`/`recovery` | `stopping` | User stops workspace | `lifecycle.ts:47` |
| `stopping` | `stopped` | VM agent stop succeeds | `lifecycle.ts:55-62` |
| `stopping` | `error` | VM agent stop fails | `lifecycle.ts:64-71` |
| `running`/`recovery` | `stopped` | Task cleanup (`cleanupTaskRun`) | `task-runner.ts:93-96` |
| `running`/`creating`/`recovery` | `stopped` | Idle timeout fires | `project-data.ts:1195-1199` |
| `stopped`/`error` | `creating` | User restarts workspace | `lifecycle.ts:108` |
| `running`/`recovery`/`error` | `creating` | User rebuilds workspace | `lifecycle.ts:164` |
| any active | `deleted` | Node destroyed (cascade) | `nodes.ts:286-297` |
| any | — | User deletes workspace | `crud.ts:383` (hard DELETE from D1) |

---

## 4. Activity Tracking System

### Schema: `workspace_activity` (ProjectData DO SQLite)

```sql
CREATE TABLE workspace_activity (
  workspace_id TEXT PRIMARY KEY,
  session_id TEXT,
  last_terminal_activity_at INTEGER,  -- ms epoch, NULL until first terminal use
  last_message_at INTEGER,            -- ms epoch, NULL until first message
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)
```

Source: `apps/api/src/durable-objects/migrations.ts:217-231`

### Write Paths

| Trigger | Function | What's Updated | Creates Row? | Schedules Alarm? |
|---------|----------|---------------|-------------|-----------------|
| Session creation (workspaceId non-null) | `createSession()` | `last_message_at = now` | Yes (INSERT OR IGNORE) | **Yes** |
| Session creation (workspaceId null) | `createSession()` | Nothing | **No** | **No** |
| `linkSessionToWorkspace()` | — | Nothing in workspace_activity | **No** | **No** |
| Terminal token request | `updateTerminalActivity()` | `last_terminal_activity_at = now` | Yes (upsert) | **No** |
| Terminal heartbeat | `updateTerminalActivity()` | `last_terminal_activity_at = now` | Yes (upsert) | **No** |
| Message persisted | `updateMessageActivity()` | `last_message_at = now` | Yes (upsert) | **No** |
| Message batch persisted | `updateMessageActivity()` | `last_message_at = now` | Yes (upsert) | **No** |
| Idle timeout cleanup | — | — | — (DELETE) | Recalculates |
| Idle schedule cleanup | — | — | — (DELETE) | Recalculates |

### Read Paths

| Purpose | Function | Query |
|---------|----------|-------|
| Idle check | `checkWorkspaceIdleTimeouts()` | `SELECT ... FROM workspace_activity wa INNER JOIN chat_sessions cs ON cs.workspace_id = wa.workspace_id WHERE cs.status = 'active'` |
| Alarm scheduling | `recalculateAlarm()` | `SELECT MIN(...) as earliest FROM workspace_activity` |

### Terminal Activity Endpoints

**`POST /api/terminal/token`** — `apps/api/src/routes/terminal.ts:21-79`
- Generates JWT for terminal WebSocket
- Fires `updateTerminalActivity()` via `waitUntil()` (best-effort, non-blocking)

**`POST /api/terminal/activity`** — `apps/api/src/routes/terminal.ts:85-121`
- Frontend heartbeat (should be called every ~1 minute)
- Fires `updateTerminalActivity()` (blocking, awaited)
- Controlled by `TERMINAL_ACTIVITY_THROTTLE_MS` on the client side

---

## 5. Idle Detection & Timeout

### Configuration Hierarchy

1. **Per-project:** `projects.workspace_idle_timeout_ms` in D1 (set via Project Settings UI)
2. **Env var:** `WORKSPACE_IDLE_TIMEOUT_MS`
3. **Default:** `DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS` = 7,200,000 ms (2 hours) — `packages/shared/src/constants.ts`

### How It Works

**Alarm handler:** `apps/api/src/durable-objects/project-data.ts:814-903`

The DO alarm fires periodically and calls `checkWorkspaceIdleTimeouts()` — `project-data.ts:1097-1186`:

1. Read per-project timeout from D1 (falls back to env/default on error)
2. Query all workspaces in `workspace_activity` INNER JOINed with `chat_sessions` WHERE `cs.status = 'active'`
3. For each workspace: `lastActivity = MAX(last_terminal_activity_at, last_message_at, session_updated_at)`
4. If `lastActivity < (now - timeoutMs)`: workspace is idle → clean up

**Cleanup actions when idle detected** (`project-data.ts:1153-1183`):

1. Stop chat session: `stopSessionInternal(sessionId)` — sets `chat_sessions.status = 'stopped'`
2. Mark workspace stopped in D1: `deleteWorkspaceInD1(workspaceId)` — `UPDATE workspaces SET status = 'stopped' WHERE id = ? AND status IN ('running', 'creating', 'recovery')`
3. Delete `workspace_activity` row (prevents perpetual alarm loop)
4. Record `workspace.idle_timeout` activity event
5. Broadcast event to WebSocket clients

### Alarm Scheduling

**`recalculateAlarm()`** — `project-data.ts:909-959`

Computes next alarm as the minimum of:
- Earliest `idle_cleanup_schedule.cleanup_at`
- Earliest ACP session heartbeat timeout
- Earliest `workspace_activity` timestamp + `WORKSPACE_IDLE_CHECK_INTERVAL_MS` (5 min)

If no candidates, alarm is deleted. If candidates exist, alarm set to `MIN(candidates)`.

### Check Interval

`WORKSPACE_IDLE_CHECK_INTERVAL_MS` = 300,000 ms (5 min) — `packages/shared/src/constants.ts`

---

## 6. Chat Session Lifecycle

### Session Status Transitions

| From | To | Trigger | Code Path |
|------|----|---------|-----------|
| — | `active` | Session created | `project-data.ts:119` |
| `active` | `stopped` | Idle timeout fires | `project-data.ts:1156` |
| `active` | `stopped` | Idle cleanup schedule fires | `project-data.ts:840` |
| `active` | `stopped` | Task marked `completed` (user or callback) | `tasks/crud.ts:383, 589` |
| `active` | `stopped` | Task marked `failed`/`cancelled` (callback) | `tasks/crud.ts:589` |
| `active` | `stopped` | Task runner DO startup fails | `tasks/submit.ts:364` |
| `active` | `stopped` | Conversation closed | `tasks/crud.ts:896` |
| `active` | `stopped` | Explicit `stopSession()` API call | `project-data.ts:976` via service |

### What Does NOT Stop the Session

- **`POST /workspaces/:id/stop`** — stops workspace only, does NOT touch chat session (`lifecycle.ts:29-87`)
- **`DELETE /workspaces/:id`** — deletes workspace record, does NOT stop chat session (`crud.ts:362-387`)
- **Node destruction via cron** — cascades workspace status to `deleted`, does NOT stop chat session
- **VM agent crash/disconnect** — no session status change

---

## 7. Node Cleanup & VM Destruction

### Three-Layer Defense

#### Layer 1: NodeLifecycle DO Alarm (Primary)

**File:** `apps/api/src/durable-objects/node-lifecycle.ts`

State machine: `active` → `warm` → `destroying`

| Transition | Trigger | Code Path |
|-----------|---------|-----------|
| active → warm | `markIdle(nodeId, userId)` | `node-lifecycle.ts:52-78` |
| warm → active | `tryClaim(taskId)` | `node-lifecycle.ts:110-133` |
| warm → active | `markActive()` | `node-lifecycle.ts:84-102` |
| warm → destroying | Alarm fires after `NODE_WARM_TIMEOUT_MS` (default 30 min) | `node-lifecycle.ts:153-194` |

When alarm fires and node is still `warm`:
1. Transition to `destroying`
2. Update D1: `status='stopped'`, `warm_since=NULL`, `health_status='stale'`
3. Cron sweep picks it up for actual VM destruction

#### Layer 2: Cron Sweep (`runNodeCleanupSweep`)

**File:** `apps/api/src/scheduled/node-cleanup.ts:53-338`
**Schedule:** Every 5 minutes (`*/5 * * * *` in `wrangler.toml:3`)

**Sub-layer 2a: Stale Warm Nodes** (lines 68-145)
- Query: nodes with `warm_since < (now - NODE_WARM_GRACE_PERIOD_MS)` AND `status = 'running'`
- If no running workspaces → `deleteNodeResources()` → VM destroyed
- If running workspaces exist → clear `warm_since` (shouldn't be warm)

**Sub-layer 2b: Auto-Provisioned Node Max Lifetime** (lines 147-237)
- Query: auto-provisioned nodes with `created_at < (now - MAX_AUTO_NODE_LIFETIME_MS)` AND not stopped/deleted
- If no active workspaces → `deleteNodeResources()` → VM destroyed
- If active workspaces exist → skip (workspace idle detection handles this)

**Sub-layer 2c: Orphaned Task Workspaces** (lines 239-290)
- Query: `status='running'` workspaces where all associated tasks are terminal
- **LOG ONLY** — does NOT destroy (flagged in observability DB)

**Sub-layer 2d: Orphaned Nodes** (lines 292-335)
- Query: `status='running'`, `warm_since IS NULL`, no active workspaces, stale `updated_at`
- **LOG ONLY** — does NOT destroy (flagged in observability DB)

#### Layer 3: Workspace Idle Timeout in ProjectData DO

See [Section 5](#5-idle-detection--timeout) above. Sets workspace to `stopped` in D1, which the cron sweep can then cascade via node destruction.

### Actual VM Destruction

**`deleteNodeResources()`** — `apps/api/src/services/nodes.ts:314-353`

1. Look up user's encrypted cloud provider credentials from D1
2. Decrypt and create provider instance
3. Call `provider.deleteVM(providerInstanceId)` — Hetzner/Scaleway API
4. Delete DNS record via Cloudflare API
5. **Does NOT update D1** — callers must update node/workspace status

### Cascade Behavior

**`stopNodeResources()`** — `apps/api/src/services/nodes.ts:242-312`

When explicitly stopping a node:
- Updates ALL workspaces on node to `status='deleted'` — `nodes.ts:286-297`

**`deleteNodeResources()`** — `nodes.ts:314-353`

When destroying a node:
- Does NOT cascade to workspaces (callers may or may not do this)

---

## 8. Chat UI Status Display

### What the User Sees

The chat header shows a status indicator: **Active** (green), **Idle** (amber), or **Stopped** (gray).

**Component:** `apps/web/src/components/chat/ProjectMessageView.tsx:1015-1022`

```typescript
// Derives from chat SESSION status, NOT workspace status
const sessionState = session ? deriveSessionState(session) : 'terminated';
// session.status === 'stopped' → 'terminated'
// session.isIdle || session.agentCompletedAt → 'idle'
// session.status === 'active' → 'active'
```

Source: `ProjectMessageView.tsx:296-303`

### Workspace Data Loading

**One-time fetch, no polling:**

```typescript
// ProjectMessageView.tsx:456-483
useEffect(() => {
  const wsId = session?.workspaceId;
  if (!wsId) return;
  if (workspace?.id === wsId) return;  // Already fetched — skip
  // ... fetch workspace data once ...
}, [session?.workspaceId, workspace?.id]);
```

The workspace object is loaded exactly once when the session's `workspaceId` becomes available. It is **never re-fetched** or polled.

### Session Data Polling

**Polls every 3 seconds while session is active:**

```typescript
// ProjectMessageView.tsx:540-576
useEffect(() => {
  if (!session || session.status !== 'active') return;  // Only poll active sessions
  const pollInterval = setInterval(async () => {
    const data = await getChatSession(projectId, sessionId, ...);
    setSession(data.session);
    setMessages(data.messages);
    // ... updates session and messages, NOT workspace ...
  }, 3000);
  return () => clearInterval(pollInterval);
}, [session?.status, ...]);
```

**Key:** Polling reads session status from the DO. When `session.status` changes to `'stopped'` in the DO, the next poll picks it up and the UI updates. But polling STOPS once `session.status !== 'active'`, which is correct (no need to poll a stopped session).

### The Workspace Page Has Polling (But Chat Doesn't)

The full workspace page (`apps/web/src/pages/Workspace.tsx:308-320`) polls every 5 seconds for workspace status. The chat view does not.

### The "Mark Complete" Button

**`handleMarkComplete()`** — `SessionHeader` in `ProjectMessageView.tsx`

1. Calls `updateProjectTaskStatus(projectId, taskId, { toStatus: 'completed' })` — this stops the session server-side
2. Calls `deleteWorkspace(workspaceId)` — hard-deletes the workspace
3. Calls `onSessionMutated?.()` — triggers `loadSessions()` in the parent to refresh the session list without a full page reload (see `.claude/rules/16-no-page-reload-on-mutation.md`)

This button stops the session AND deletes the workspace AND refreshes the session list via React state.

---

## 9. Known Bugs & Gaps

### BUG 1: Task-Driven Workspaces May Not Get Idle Timeout Checks

**Severity: HIGH — workspaces run forever**

For task-driven workspaces (Path B):
- Session created with `workspaceId=null` → no `workspace_activity` row, no alarm scheduled
- `linkSessionToWorkspace()` doesn't create `workspace_activity` row or schedule alarm
- `updateMessageActivity()` creates the row via upsert but doesn't call `recalculateAlarm()`
- `updateTerminalActivity()` creates the row via upsert but doesn't call `recalculateAlarm()`
- Result: `workspace_activity` row exists but alarm may never be scheduled to check it

**Impact:** If nothing else triggers a DO alarm (ACP heartbeat, idle cleanup schedule), the workspace is never checked for idleness. Even when the alarm DOES fire for other reasons, the workspace idle check runs incidentally — not reliably.

**Fix needed:** Either `linkSessionToWorkspace()` should create the `workspace_activity` row and call `recalculateAlarm()`, or `updateMessageActivity()`/`updateTerminalActivity()` should call `recalculateAlarm()`.

### BUG 2: Stopping Workspace Doesn't Stop Chat Session

**Severity: HIGH — UI shows "Active" forever**

`POST /workspaces/:id/stop` (`lifecycle.ts:29-87`):
- Sets workspace D1 status to `stopping` → `stopped`
- Records `workspace.stopped` activity event
- **Does NOT call `projectDataService.stopSession()`**

`DELETE /workspaces/:id` (`crud.ts:362-387`):
- Hard-deletes workspace from D1
- **Does NOT call `projectDataService.stopSession()`**

Result: Chat session stays `active` in DO SQLite. The chat UI, which derives its status indicator from `session.status`, continues showing "Active" indefinitely.

The only way to stop the session from the UI is the "Mark Complete" button (`handleMarkComplete`), which calls `updateProjectTaskStatus` — and THAT route stops the session. But stopping or deleting the workspace via the workspace page or API does not.

**Fix needed:** `POST /workspaces/:id/stop` and `DELETE /workspaces/:id` should call `projectDataService.stopSession()` when the workspace has a `chatSessionId`.

### BUG 3: Chat UI Never Refreshes Workspace Data

**Severity: MEDIUM — stale workspace status in UI**

`ProjectMessageView.tsx:456-483` loads workspace data exactly once. Even if the workspace status changes server-side (via stop, idle timeout, error, or node destruction), the chat UI never re-fetches it.

The session status DOES update via polling (every 3s), but the workspace object is static.

**Impact:** The workspace status shown in the chat details panel is always the status at the time it was first loaded.

**Fix needed:** Either poll workspace status periodically, or derive workspace-related UI state from the session (which IS polled).

### BUG 4: Orphaned Workspaces Are Flagged But Not Cleaned Up

**Severity: HIGH — running workspaces consume cloud resources**

The cron sweep (sub-layer 2c, `node-cleanup.ts:239-290`) identifies workspaces where:
- Status = `running`
- All associated tasks are completed/failed/cancelled
- No active tasks remain

These are logged to observability but **not stopped or destroyed**.

**Fix needed:** These workspaces should be stopped (or at minimum, their sessions should be stopped so idle timeout can clean them up).

### BUG 5: Node Destruction Doesn't Cascade to Workspace D1 Records

**Severity: MEDIUM — orphaned D1 records**

`deleteNodeResources()` (`nodes.ts:314-353`) destroys the VM and DNS but does not update workspace status in D1. When called from the cron sweep, the caller updates the node status to `deleted` but does NOT update associated workspaces.

Only `stopNodeResources()` (`nodes.ts:286-297`) cascades to workspaces — and it's only called for explicit node stops, not cron destruction.

**Fix needed:** After `deleteNodeResources()`, callers should cascade workspace status to `deleted` or `stopped`.

### BUG 6: Silent Credential Lookup Failure Orphans VMs

**Severity: CRITICAL — orphaned VMs incur cloud costs**

`deleteNodeResources()` (`nodes.ts:333-343`):
```typescript
const credResult = await getUserCloudProviderConfig(...);
if (credResult) {  // if null, silently skip VM deletion
  const provider = createProvider(credResult.config);
  await provider.deleteVM(node.providerInstanceId);
}
```

If the user has deleted their cloud credentials, the VM deletion is silently skipped. The node is marked `deleted` in D1 but the actual VM keeps running in Hetzner, consuming resources.

**Fix needed:** At minimum, log a CRITICAL-level warning. Ideally, notify the user that they have orphaned VMs.

### GAP 7: Idle Cleanup Schedule vs Workspace Idle Timeout — Overlapping Mechanisms

Two separate idle-triggered cleanup mechanisms exist:

1. **`idle_cleanup_schedule` table** — scheduled after agent completion, fires after `SESSION_IDLE_TIMEOUT_MINUTES` (default 15 min). Stops session, stops workspace in D1, deletes workspace_activity.

2. **`workspace_activity`-based idle check** — fires when workspace has no terminal/message activity for `WORKSPACE_IDLE_TIMEOUT_MS` (default 2 hours). Stops session, stops workspace in D1, deletes workspace_activity.

Both mechanisms do the same cleanup actions but are triggered independently. The idle_cleanup_schedule is more aggressive (15 min) and applies after agent completion. The workspace_activity check is a safety net for workspaces where the agent never completes or where no idle schedule was set.

**Not a bug per se**, but the overlap makes the system harder to reason about.

---

## 10. Quick Reference: Who Stops What

### When workspace is stopped, what else is stopped?

| Workspace Stop Trigger | Stops Workspace? | Stops Chat Session? | Deletes workspace_activity? | Triggers Node Cleanup? |
|------------------------|:-:|:-:|:-:|:-:|
| `POST /workspaces/:id/stop` (user) | Yes | **NO** | **NO** | No |
| `DELETE /workspaces/:id` (user) | Deleted | **NO** | **NO** | No |
| `cleanupTaskRun()` (task completion) | Yes | No (separate path) | **NO** | Marks node warm |
| Idle timeout alarm | Yes | Yes | Yes | No (cron picks up) |
| Idle cleanup schedule | Yes | Yes | Yes | No (cron picks up) |
| Task status → completed (user/callback) | No | Yes | **NO** | Triggers cleanup |
| Node destroyed (cron) | Cascade to `deleted` (sometimes) | **NO** | **NO** | N/A |

### When session is stopped, what else is stopped?

| Session Stop Trigger | Stops Session? | Stops Workspace? | Deletes workspace_activity? |
|---------------------|:-:|:-:|:-:|
| Task → completed/failed/cancelled | Yes | Via cleanupTaskRun | **NO** |
| Idle timeout alarm | Yes | Yes | Yes |
| Idle cleanup schedule | Yes | Yes | Yes |
| Conversation closed | Yes | No | **NO** |
| `POST /workspaces/:id/stop` | **NO** | Yes | **NO** |
| `DELETE /workspaces/:id` | **NO** | Deleted | **NO** |

### Key Insight

The workspace and session lifecycles are **not synchronized**. Stopping a workspace doesn't stop the session, and stopping a session doesn't always stop the workspace. Only the idle timeout and idle cleanup schedule mechanisms stop both. This is the root cause of the "Active forever" bug.
