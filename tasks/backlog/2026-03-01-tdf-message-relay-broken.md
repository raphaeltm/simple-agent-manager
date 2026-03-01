# TDF Message Relay Broken — Agent Output Never Reaches Chat UI

## Problem Statement

When a user submits a task via the TDF system, the task runner correctly creates a workspace and starts the agent. The agent completes the work successfully (verifiable by opening the workspace directly). However, the agent's output messages are never relayed back to the chat UI.

**User-reported symptoms:**
1. Task submission works — creates workspace, submits initial message
2. Switching away from a task loses provisioning status updates
3. Coming back shows only the original user message — no agent output
4. Even after waiting, no progress messages appear
5. Clicking into the workspace reveals the agent DID complete the work
6. This affects multiple concurrent tasks

## Root Cause Analysis

### Bug 1 (CRITICAL): VM Agent Message Reporter Not Initialized for Task Workspaces

**Files:** `apps/api/src/services/nodes.ts:72-150`, `packages/vm-agent/internal/server/server.go:194-218`

The VM agent's `messagereport.Reporter` is initialized at **server startup** from node-level env vars (`PROJECT_ID`, `CHAT_SESSION_ID`). For auto-provisioned task nodes:
- `provisionNode()` calls `generateCloudInit()` without `projectId` or `chatSessionId`
- The cloud-init template substitutes empty strings for `{{ project_id }}` and `{{ chat_session_id }}`
- On VM boot, `PROJECT_ID=""` and `CHAT_SESSION_ID=""`
- `messagereport.New()` returns `(nil, nil)` when these are empty (intentional no-op)
- **Result: The message reporter is nil. Agent messages are silently dropped — never enqueued, never sent to the API.**

For warm node reuse: the cloud-init has the ORIGINAL task's project/session IDs (stale), so messages would go to the wrong session.

### Bug 2 (CRITICAL): WebSocket `messages.batch` Not Handled by Frontend

**Files:** `apps/web/src/hooks/useChatWebSocket.ts:108`, `apps/api/src/durable-objects/project-data.ts:321-326`

Even if messages WERE persisted, real-time delivery is broken:
- VM agent sends batch messages → `POST /api/workspaces/:id/messages` → `persistMessageBatch()`
- ProjectData DO broadcasts `messages.batch` event
- Frontend `useChatWebSocket` only handles `message.new` and `session.stopped`
- `messages.batch` events are silently ignored

### Bug 3: WebSocket `message.new` Broadcast Missing Content

**Files:** `apps/api/src/durable-objects/project-data.ts:217`, `apps/web/src/hooks/useChatWebSocket.ts:109-115`

The `message.new` broadcast payload only includes `{ sessionId, messageId, role }` — no `content` or `createdAt`. The frontend handler constructs a `ChatMessageResponse` with `content: undefined`, producing blank message bubbles.

### Bug 4 (UX): Provisioning State Lost on Navigation

**Files:** `apps/web/src/pages/ProjectChat.tsx`

`ProvisioningState` is ephemeral React state. Navigating away loses the live progress indicator (execution step, elapsed time). On return, only a static task embed is shown.

## Implementation Plan

### Phase 1: Fix message reporter initialization (Go + API changes)

The VM agent needs per-workspace message reporters. This requires:

1. **API: Pass projectId and chatSessionId in workspace creation request**
   - `apps/api/src/services/node-agent.ts:createWorkspaceOnNode()` — add projectId, chatSessionId to payload
   - `apps/api/src/durable-objects/task-runner.ts:handleWorkspaceCreation()` — pass project/session info

2. **VM Agent: Accept and use per-workspace project/session in workspace creation**
   - `packages/vm-agent/internal/server/workspaces.go:handleCreateWorkspace()` — parse projectId, chatSessionId from body
   - Store on WorkspaceRuntime so the ACP gateway can use per-workspace reporter config

3. **VM Agent: Create per-workspace message reporters**
   - When creating an agent session, check if workspace has project/session info
   - Create a workspace-scoped reporter (or update the existing one)
   - This is the architecturally correct fix but requires significant Go refactoring

**INTERIM FIX (simpler):** Pass projectId and chatSessionId to cloud-init for auto-provisioned task nodes. This covers the primary use case (one task per auto-provisioned node) without Go changes.
   - `apps/api/src/durable-objects/task-runner.ts:handleNodeProvisioning()` — pass project/session to provisionNode
   - `apps/api/src/services/nodes.ts:provisionNode()` — accept and forward to generateCloudInit
   - `packages/cloud-init/src/generate.ts` — already supports these vars, just need to pass them

### Phase 2: Fix frontend WebSocket handling

1. **Handle `messages.batch` in useChatWebSocket**
   - Add handler for `messages.batch` event type
   - Extract messages array from payload and merge into state

2. **Fix `message.new` broadcast to include full message data**
   - Update ProjectData DO `persistMessage()` to broadcast full message content
   - OR: Have the frontend fetch the message via REST when it gets a `message.new` notification

3. **Handle additional session events**
   - `session.agent_completed` — update session state to show idle indicator
   - `session.updated` — update workspace link

### Phase 3: Improve provisioning UX

1. **Restore provisioning state on navigation return**
   - When loading a session linked to a non-terminal task, check task status via embed
   - If task is still provisioning (queued/delegated), show ProvisioningIndicator
   - Resume polling task status

## Checklist

- [ ] Pass projectId + chatSessionId to cloud-init for auto-provisioned nodes
  - [ ] Modify task-runner to pass project/session info to provisionNode
  - [ ] Modify provisionNode to accept and forward to generateCloudInit
  - [ ] Update cloud-init generation test
- [ ] Fix WebSocket `messages.batch` handling in useChatWebSocket
  - [ ] Add `messages.batch` event handler
  - [ ] Merge batch messages into state with dedup
- [ ] Fix `message.new` broadcast to include content
  - [ ] Update ProjectData DO persistMessage() broadcast payload
- [ ] Handle `session.agent_completed` WebSocket event
- [ ] Restore provisioning indicator on session return
  - [ ] Detect active provisioning from task embed status
  - [ ] Resume task status polling
- [ ] Add capability tests
  - [ ] Test batch message WebSocket delivery
  - [ ] Test message.new broadcast includes content
  - [ ] Test provisioning state restoration
- [ ] Write post-mortem in docs/notes/

## Acceptance Criteria

1. Agent output messages appear in the chat UI in real-time (via WebSocket)
2. Messages appear on page reload/navigation return (via REST polling)
3. Provisioning progress is visible even after navigating away and back
4. Multiple concurrent tasks each show their correct messages

## References

- `apps/api/src/durable-objects/project-data.ts` — ProjectData DO with WebSocket broadcast
- `apps/api/src/durable-objects/task-runner.ts` — Task orchestration DO
- `apps/api/src/services/node-agent.ts` — Node agent API client
- `apps/api/src/services/nodes.ts` — Node provisioning
- `apps/web/src/hooks/useChatWebSocket.ts` — WebSocket hook
- `apps/web/src/components/chat/ProjectMessageView.tsx` — Message display
- `apps/web/src/pages/ProjectChat.tsx` — Chat page with provisioning
- `packages/vm-agent/internal/messagereport/reporter.go` — Message outbox reporter
- `packages/vm-agent/internal/server/server.go` — VM agent server init
- `packages/cloud-init/src/generate.ts` — Cloud-init template generation
