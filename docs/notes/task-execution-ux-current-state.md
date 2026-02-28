# Task Execution UX: Current State and Path Forward

This document explains how the task execution workflow currently works in SAM based purely on the code as of 2026-02-24, and outlines what needs to change to reach the desired end state.

---

## 1. Current Architecture Overview

Task execution spans four major subsystems:

| Subsystem | Location | Responsibility |
|-----------|----------|----------------|
| **Task Runner** | `apps/api/src/services/task-runner.ts` | Orchestrates node selection, workspace creation, agent session creation |
| **Node Lifecycle** | `apps/api/src/durable-objects/node-lifecycle.ts` | Per-node warm pool state machine (active/warm/destroying) |
| **ProjectData DO** | `apps/api/src/durable-objects/project-data.ts` | Per-project chat sessions, messages, activity events |
| **VM Agent** | `packages/vm-agent/` (Go) | Runs on each node; manages Docker containers, PTY, ACP sessions |

The control plane is a Cloudflare Worker. All long-running task execution happens via `waitUntil()` — the API returns 202 immediately and execution continues asynchronously.

---

## 2. Current Task Lifecycle

### 2.1 The Task State Machine

The codebase defines 8 task statuses (`packages/shared/src/types.ts:259`):

```
draft → ready → queued → delegated → in_progress → completed
                                                  → failed
                                                  → cancelled
```

Allowed transitions are explicit (`apps/api/src/services/task-status.ts:11-21`):

```
draft:        [ready, cancelled]
ready:        [queued, delegated, cancelled]
queued:       [delegated, failed, cancelled]
delegated:    [in_progress, failed, cancelled]
in_progress:  [completed, failed, cancelled]
completed:    []  (terminal)
failed:       [ready, cancelled]  (retryable)
cancelled:    [ready]  (retryable)
```

Every transition is recorded as a `taskStatusEvent` with actor, reason, and timestamp.

### 2.2 Submission Flow: What Happens When a User Clicks "Run Now"

The frontend (`apps/web/src/pages/ProjectChat.tsx:63-86`) makes **three sequential API calls**:

```
1. POST /api/projects/:projectId/tasks          → creates task in "draft" status
2. POST /api/projects/:projectId/tasks/:id/status → transitions to "ready"
3. POST /api/projects/:projectId/tasks/:id/run   → transitions to "queued", kicks off execution
```

The `/run` endpoint (`apps/api/src/routes/task-runs.ts:33-104`) validates the task is in `ready` status, checks for Hetzner credentials, and calls `initiateTaskRun()`. This function transitions the task to `queued`, returns a 202 immediately, and queues async execution via `waitUntil()`.

The "Save to Backlog" button only calls step 1 — creating the task in `draft`.

### 2.3 Async Execution: What Happens Inside `executeTaskRun`

The `executeTaskRun` function (`task-runner.ts:121-380`) runs entirely inside `waitUntil` and proceeds through these stages:

**Stage 1 — Node Selection** (`task-runner.ts:169-211`)
1. If a preferred node ID was provided, validate it's running and use it
2. Otherwise, call `selectNodeForTaskRun()` which:
   - First tries to claim a warm node via `nodeLifecycleService.tryClaim()` (`node-selector.ts:110-149`)
   - Then scans running nodes with available capacity (CPU/memory/workspace count)
   - Returns `null` if nothing available
3. If no node found, auto-provision:
   - Check user hasn't hit `maxNodesPerUser` limit
   - Create node record in D1 (`status: creating`)
   - Call `provisionNode()` — creates Hetzner server + DNS record
   - Wait for VM agent to become healthy via `waitForNodeAgentReady()`
   - Store `autoProvisionedNodeId` on task for cleanup tracking

**Stage 2 — Workspace Creation** (`task-runner.ts:213-265`)
1. Create workspace record in D1 (`status: creating`)
2. Transition task: `queued → delegated`
3. Create chat session in ProjectData DO (best-effort; failure doesn't block)
4. Set `outputBranch = task/{taskId}` on the task record
5. Sign a 24-hour callback JWT for the workspace
6. Call VM agent `POST /workspaces` with repository, branch, callback token, git credentials
7. Poll D1 workspace status until it becomes `running` or `recovery` (2s intervals, exponential backoff to 10s, 5-minute timeout)

**Stage 3 — Agent Session** (`task-runner.ts handleAgentSession`)
1. Create agent session record in D1 (`status: running`)
2. Call VM agent `POST /workspaces/:id/agent-sessions` to create the ACP session
3. Call VM agent `POST /workspaces/:id/agent-sessions/:sessionId/start` to start the agent with the task description as the initial prompt
4. Transition task: `delegated → in_progress`

At this point the task runner is done. The agent runs autonomously.

### 2.4 Progress Feedback in the UI

After the frontend calls `/run`, it:

1. Sets `activeTaskId` and renders `TaskExecutionProgress` (`apps/web/src/components/task/TaskExecutionProgress.tsx`)
2. The component polls `GET /api/projects/:projectId/tasks/:id` every 2 seconds
3. It maps task status to user-visible labels:
   - `queued` → "Provisioning infrastructure..."
   - `delegated` → "Creating workspace and starting agent..."
   - `in_progress` → "Agent is working on the task"
   - `completed` → "Task completed successfully"
   - `failed` → "Task execution failed" + error message
4. A progress bar shows 25% → 50% → 75% → 100% corresponding to the 4 execution stages
5. When the task reaches `in_progress` with a `workspaceId`, the `onSessionReady` callback fires
6. `ProjectChat` handles this by reloading sessions and auto-navigating to the newest chat session
7. `ProjectMessageView` loads messages and connects a WebSocket for real-time updates
8. The VM agent pushes messages in batches to `POST /api/workspaces/:id/messages`, which persists them in the ProjectData DO and broadcasts via WebSocket

### 2.5 Task Completion and Cleanup

**Completion Signal**: The workspace calls back to `POST /api/projects/:projectId/tasks/:taskId/status/callback` (`apps/api/src/routes/tasks.ts:430-513`) with a signed JWT. This transitions the task to `completed` (or `failed`/`cancelled`).

**Cleanup trigger**: Only `completed` status triggers cleanup. Failed/cancelled tasks preserve the workspace for debugging.

**What `cleanupTaskRun` does** (`task-runner.ts:382-422`):
1. Wait a configurable delay (`TASK_RUN_CLEANUP_DELAY_MS`, default 5s)
2. Stop the workspace via VM agent (`POST /workspaces/:id/stop`)
3. Mark workspace as `stopped` in D1
4. If the node was auto-provisioned, call `cleanupAutoProvisionedNode`:
   - Count remaining active workspaces on the node
   - If none, call `nodeLifecycleService.markIdle()` to enter warm pool
   - If markIdle fails, stop the node directly as fallback

**What cleanup does NOT do**: There is no git push step. The code comments say "the agent pushes changes to a branch" but this is not enforced by the control plane. If the agent didn't push, changes are lost when the workspace container is stopped.

### 2.6 Failure and Recovery

**Stuck task recovery** (`apps/api/src/scheduled/stuck-tasks.ts`) runs on cron and detects tasks that have been in transient states too long:
- `queued` for > 10 minutes (default `DEFAULT_TASK_STUCK_QUEUED_TIMEOUT_MS`)
- `delegated` for > 16 minutes (default `DEFAULT_TASK_STUCK_DELEGATED_TIMEOUT_MS`)
- `in_progress` for > 2 hours (default `DEFAULT_TASK_RUN_MAX_EXECUTION_MS`)

Stuck tasks are transitioned to `failed` with a descriptive error message. Note: stuck task recovery does NOT clean up the associated workspace or node — it only changes the task status.

Users can retry from `failed` → `ready` → re-run.

---

## 3. Infrastructure Lifecycle

### 3.1 Node Provisioning and Warm Pooling

**Provisioning** (`apps/api/src/services/nodes.ts:58-127`):
- Creates Hetzner server with cloud-init script
- Creates backend DNS record (`vm-{nodeId}.{BASE_DOMAIN}`)
- Updates D1: `status = running`, stores IP address and provider instance ID
- VM agent boots and begins responding to health checks

**Warm Pool State Machine** (NodeLifecycle DO, `apps/api/src/durable-objects/node-lifecycle.ts`):

Three states:
- `active` — Has running workspaces. No alarm.
- `warm` — All workspaces stopped. Alarm scheduled at `now + NODE_WARM_TIMEOUT_MS` (default 30 minutes).
- `destroying` — Alarm fired. D1 marked as `stopped`; cron sweep handles Hetzner deletion.

Claiming: When a new task needs a node, the node selector first tries `tryClaim()` on warm nodes matching the requested size/location. Claimed nodes transition `warm → active` and skip provisioning entirely — this takes seconds instead of minutes.

**Three-layer defense against orphans**:
1. DO alarm (primary, configurable timeout)
2. Cron sweep for stale warm nodes > 35 minutes old (grace period above alarm)
3. Cron sweep for auto-provisioned nodes exceeding max lifetime (default 4 hours)

### 3.2 Workspace Lifecycle

Workspaces go through: `creating → running/recovery → stopped/error`.

There is no workspace warm-keeping mechanism. When a task completes, `cleanupTaskRun` immediately calls `stopWorkspaceOnNode()`, which stops the Docker container and all ACP sessions. The workspace record in D1 is marked `stopped`.

There is no idle detection, no grace period, and no mechanism for the workspace to signal "agent done, waiting for user input." The ACP session runs until explicitly stopped.

### 3.3 Agent Sessions, ACP, and Message Flow

Agent sessions are created during task execution and persist independently of browser connections. The SessionHost in the VM agent (`packages/vm-agent/internal/acp/session_host.go`) keeps the ACP session alive even when no browser tab is open.

Messages flow:
```
ACP Session (on VM) → VM Agent batches messages → POST /workspaces/:id/messages → ProjectData DO → WebSocket broadcast → Browser
```

The VM agent authenticates via the workspace callback JWT. Messages are deduplicated by `messageId` and stored in the DO's embedded SQLite.

Session suspend/resume exists (`POST /workspaces/:id/agent-sessions/:sessionId/suspend|resume`) — this suspends the ACP session on the VM but does NOT trigger any workspace cleanup. There is an auto-suspend mechanism based on idle timeout, but it only suspends the agent session, not the workspace.

---

## 4. Gap Analysis: Where We Are vs Where We Need to Be

### 4.1 Task State Simplification

| Current | Desired |
|---------|---------|
| 8 statuses exposed to user (draft, ready, queued, delegated, in_progress, completed, failed, cancelled) | 3 user-facing states: **draft** (brainstorming), **submitted** (executing), **completed** |
| Progress bar shows 4 distinct internal stages | Single "executing" state with activity indicator |
| Kanban board has columns for every status | Kanban simplified to Draft / Active / Done |

**The core problem**: The `ready` state exists as a holding pen between "user prepared the task" and "system started executing." For the "Run Now" flow, it's a useless intermediate. The `queued → delegated → in_progress` progression leaks implementation details (node provisioning stages) into the user experience.

**What needs to change**:
- A new `/submit` endpoint (or modified `/run`) that accepts a draft-or-nothing and goes directly to execution
- The frontend makes a single API call instead of three
- The progress UI shows "Executing..." with an activity indicator rather than mapping internal states to user-visible steps
- Internal states still exist for the backend's benefit but the API response and UI abstract them as "submitted/executing"

### 4.2 Workspace Warm Period After Agent Completion

| Current | Desired |
|---------|---------|
| Workspace stopped immediately on task completion | Workspace stays alive ~15 minutes after agent signals "done" |
| No "waiting for input" signal | Agent signals completion → workspace enters warm period |
| No user interaction possible after agent finishes | User can send follow-up messages during warm period |
| Cleanup delay is 5 seconds (buffer for writes, not a warm period) | 15-minute warm period, then cleanup |

**This is the largest missing feature.** It requires changes across all layers:

1. **Agent completion signal**: The VM agent needs to detect when the ACP session ends (agent sends final message) and notify the control plane. Currently the only completion path is the workspace callback endpoint, called by the agent itself — but there's no mechanism for the agent to say "I'm done but keep the workspace alive."

2. **Workspace warm state**: A new workspace status or timer mechanism. When the agent signals "done," the workspace enters a warm/idle state. During this period:
   - The workspace container stays running
   - The ACP session is suspended but resumable
   - The chat session stays `active`
   - The user can send messages through the UI, which get relayed to the VM agent, which resumes the ACP session

3. **Idle timeout**: After 15 minutes of no user interaction, the workspace is cleaned up (git push → stop → node idle).

4. **UI interaction**: The chat view needs an input field for sending messages to the running workspace, not just viewing.

### 4.3 Guaranteed Git Push Before Cleanup

| Current | Desired |
|---------|---------|
| `outputBranch` set to `task/{taskId}` before agent starts | Same |
| No enforced git push — comment says "agent pushes" | Control plane ensures git push before workspace stop |
| If agent didn't push, changes lost on cleanup | All changes preserved on task-identified branch |

**What needs to change**:
1. Before `stopWorkspaceOnNode()`, call a new VM agent endpoint: `POST /workspaces/:id/git-push` that:
   - Checks if there are uncommitted changes or unpushed commits
   - Commits any uncommitted changes with a standard message
   - Force-pushes to `task/{taskId}` branch
   - Returns the commit SHA and push status
2. Update `cleanupTaskRun()` to call this before stopping
3. Handle edge cases: no git repo, no changes, auth failures, push conflicts
4. Store the final commit SHA on the task record

### 4.4 Interactive Follow-up (User → Agent During Warm Period)

| Current | Desired |
|---------|---------|
| Messages flow VM→ControlPlane→Browser only | Bidirectional: user can send messages to agent |
| No input field in chat view | Input field appears during workspace warm period |
| Agent session is fire-and-forget | Agent session can be resumed with new user input |

**This builds on 4.2** (workspace warm period) and requires:
1. A `POST /api/projects/:projectId/sessions/:sessionId/messages` endpoint for user-sent messages
2. The control plane relays to the VM agent, which injects the message into the ACP session
3. The ACP session resumes if suspended
4. The idle timer resets on each user message
5. The UI renders an input field when the workspace is in warm state

### 4.5 Fan-Out / Multi-Task Submission

| Current | Desired |
|---------|---------|
| One task submitted at a time | Easy to submit many tasks in sequence |
| Single progress tracker per ProjectChat | Multiple concurrent task progress visible |
| Node selector distributes across available nodes | Same (this works) |
| Each task independent via `waitUntil` | Same (this works) |

**The backend already supports fan-out** — each task execution is independent and `waitUntil` handles concurrency. Node selector distributes workloads across nodes with capacity. Warm node claiming prevents unnecessary provisioning for sequential submissions.

**What's missing is UI support**:
- The progress tracker currently handles only one `activeTaskId`
- Submitting a second task while one is running would overwrite the first tracker
- Need a list/queue of active task executions with individual progress
- Project overview should show all active tasks, not just the most recent

---

## 5. Implementation Roadmap

These are ordered by dependency. Each phase builds on the previous.

### Phase 1: Single-Action Submission

**Goal**: "Run Now" is one API call, intermediate states invisible to user.

1. New `POST /api/projects/:projectId/tasks/submit` endpoint that:
   - Creates task in `draft` (or a new internal `submitted` status)
   - Validates credentials and dependencies
   - Calls `initiateTaskRun()` internally
   - Returns `{ taskId, status: 'submitted' }` — never exposes `ready` or `queued`
2. Frontend calls one endpoint instead of three
3. Progress UI shows "Executing..." instead of Provisioning/Setting Up/Running
4. Simplify task status badge mapping in UI to: draft | executing | completed | failed

**Scope**: API endpoint (~50 lines), frontend simplification (~30 lines), UI component updates.

### Phase 2: Guaranteed Git Push Before Cleanup

**Goal**: No workspace cleanup without a git push to the task branch.

1. VM agent: New `POST /workspaces/:id/git-push` endpoint
   - Commits uncommitted changes (if any) with message "Task auto-commit: {taskId}"
   - Pushes to `task/{taskId}` branch
   - Returns `{ pushed: bool, commitSha: string, hasChanges: bool }`
2. Control plane: `cleanupTaskRun()` calls git-push before `stopWorkspaceOnNode()`
3. Store final commit SHA on task record
4. Handle failures gracefully (log, don't block cleanup entirely)

**Scope**: VM agent endpoint (~50 lines Go), task-runner.ts modification (~20 lines), node-agent.ts addition (~10 lines).

### Phase 3: Workspace Warm Period

**Goal**: Workspaces stay alive for 15 minutes after agent completion.

1. New task status or field: `awaiting_input` (or reuse `in_progress` with a flag)
2. When the agent signals completion, instead of immediate cleanup:
   - Transition task to a "waiting" state
   - Suspend the ACP session (already supported)
   - Start a 15-minute idle timer (could use a similar pattern to NodeLifecycle DO alarm)
3. If timer expires: trigger git push → cleanup → mark task completed
4. If user sends input: reset timer, resume ACP session (see Phase 4)
5. New env var: `WORKSPACE_WARM_TIMEOUT_MS` (default 15 min)

**Scope**: Task runner changes, new DO alarm pattern or timer, API endpoint modifications. Medium complexity (~200-300 lines).

### Phase 4: Interactive Follow-up

**Goal**: Users can send messages to the agent during the warm period.

1. `POST /api/projects/:projectId/sessions/:sessionId/messages` — accepts user message
2. Control plane relays to VM agent `POST /workspaces/:id/agent-sessions/:sessionId/message`
3. VM agent injects into ACP session and resumes if suspended
4. Idle timer resets on each interaction
5. UI: Input field in `ProjectMessageView` when workspace is in warm state
6. Messages appear in the same chat session as the original task execution

**Scope**: API endpoint, VM agent endpoint, ACP session resume logic, UI input component. Significant complexity (~400+ lines across layers).

### Phase 5: Multi-Task Fan-Out UI

**Goal**: Submit and track multiple tasks concurrently.

1. `ProjectChat` tracks a list of active tasks instead of a single `activeTaskId`
2. Progress area shows a stack of task progress bars
3. Each completed task's session appears in the sidebar
4. Optional: batch submit UI (multi-line input, one task per line)
5. Project overview shows a summary of active/completed/failed tasks

**Scope**: Frontend changes only (~200 lines). Backend already supports concurrent tasks.

### Phase 6: State Simplification Cleanup

**Goal**: Remove user-facing exposure of internal states.

1. API response shaping: task endpoints return a `userStatus` field that maps 8 internal states to 3 user-facing states (`draft`, `executing`, `completed`/`failed`)
2. Remove kanban columns for `ready`, `queued`, `delegated`
3. Simplify task list/filter UI
4. Keep full status in API for admin/debugging but default views use simplified status

**Scope**: API response transformation (~30 lines), UI simplification (~100 lines).

---

## 6. Summary: How Far Are We?

| Capability | Status | Gap Size |
|-----------|--------|----------|
| Task creation and execution | Working | Small (3 calls → 1) |
| Node provisioning | Working | None |
| Node warm pooling | Working | None |
| Warm node claiming/reuse | Working | None |
| Node orphan defense (3-layer) | Working | None |
| Workspace creation during task | Working | None |
| Agent session creation | Working | None |
| Chat session + message streaming | Working | None |
| Real-time progress feedback | Working | Small (state labels) |
| Task completion callback | Working | None |
| Workspace cleanup on completion | Working | None |
| Stuck task recovery | Working | None |
| Structured logging | Working | None |
| **Git push before cleanup** | **Not implemented** | **Medium** |
| **Workspace warm period** | **Not implemented** | **Large** |
| **Agent "done" signal** | **Not implemented** | **Large** |
| **User follow-up messages** | **Not implemented** | **Large** |
| **Single-action submission** | **Not implemented** | **Small** |
| **Multi-task fan-out UI** | **Not implemented** | **Medium** |
| **Simplified user-facing states** | **Not implemented** | **Small** |

The node lifecycle, warm pooling, and basic task execution pipeline work well. The major gaps are all around what happens at the **end** of task execution: keeping workspaces alive, enabling follow-up interaction, and ensuring changes are preserved. The fan-out pattern works at the backend level but the UI doesn't support it yet.
