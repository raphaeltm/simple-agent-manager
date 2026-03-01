# Post-Mortem: TDF Message Relay Failure

**Date**: 2026-03-01
**Author**: Claude (investigation session)
**Severity**: Critical — agent output never reaches users
**Status**: Fixed — all five bugs addressed

---

## What Happened

On 2026-03-01, after fixing the initial prompt delivery bug (see `2026-02-28-missing-initial-prompt-postmortem.md`), the complete task execution flow was tested. A task was submitted through the project chat UI. The system successfully:

1. Created a task and chat session
2. Provisioned a node with project context
3. Created a workspace
4. Started Claude Code with the task description
5. Agent completed work inside the workspace

**But no agent messages appeared in the chat UI.** Users saw only their original task submission message. The agent was working — logs showed Claude Code running and producing output — but that output never made it back to the browser. Additionally, navigating away from a task during provisioning and returning later showed no provisioning progress, just a static task card.

---

## Root Causes

Four distinct bugs prevented message relay from working:

### Bug 1 (CRITICAL): VM Agent Message Reporter Not Initialized

**Location**: `apps/api/src/services/nodes.ts:provisionNode()`, `packages/vm-agent/internal/server/server.go`

The VM agent's message reporter requires `PROJECT_ID` and `CHAT_SESSION_ID` environment variables to know where to send agent messages. These are set via cloud-init during node provisioning.

**What went wrong**:
1. `provisionNode()` called `generateCloudInit()` without passing `projectId` or `chatSessionId` parameters
2. The cloud-init template substituted empty strings for `PROJECT_ID` and `CHAT_SESSION_ID`
3. When the VM agent started, `messagereport.New(projectId, sessionId, ...)` received empty strings
4. The message reporter constructor intentionally returns `(nil, nil)` when IDs are empty (designed as a graceful no-op for non-task workspaces)
5. The VM agent ran with a nil message reporter
6. Agent messages were never enqueued, never sent to the control plane

**Why it wasn't caught**:
- Cloud-init template generation was tested for variable substitution, but no test verified that `provisionNode()` actually passed the required variables to the template generator
- The VM agent's message reporter has unit tests, but no integration test verified that auto-provisioned task nodes receive the correct environment variables
- Manual testing of task execution focused on workspace creation and agent startup, not message relay

### Bug 2 (CRITICAL): Frontend Ignored `messages.batch` WebSocket Events

**Location**: `apps/web/src/hooks/useChatWebSocket.ts`, `apps/api/src/durable-objects/project-data.ts`

The message relay path from VM agent to browser is:
1. VM agent batches messages and POSTs to `/api/workspaces/:id/messages`
2. API route calls `projectData.persistMessageBatch()`
3. ProjectData DO persists messages and broadcasts `messages.batch` event to WebSocket connections
4. Frontend WebSocket hook receives event and updates UI

**What went wrong**:
1. The `useChatWebSocket` hook only handled `message.new` and `session.stopped` event types
2. When a `messages.batch` event arrived, it fell through to the default case and was silently ignored
3. No messages appeared in the UI despite being successfully persisted to the DO's SQLite database

**Why it wasn't caught**:
- WebSocket event handling was tested for `message.new` and `session.stopped` but not for `messages.batch`
- The batch persistence endpoint (`POST /api/workspaces/:id/messages`) was tested for correct persistence, but no test verified that the broadcast event reached the frontend
- Each side (DO persistence + broadcast, frontend event handling) was tested in isolation
- No end-to-end test exercised the complete path: batch API call → DO broadcast → frontend receives and renders

### Bug 3: `message.new` Broadcast Payload Missing Content

**Location**: `apps/api/src/durable-objects/project-data.ts:broadcastMessageCreated()`

Even for individual message creation (not batch), the WebSocket broadcast had incomplete data.

**What went wrong**:
1. `broadcastMessageCreated()` broadcast only `{ sessionId, messageId, role }` — no `content` or `createdAt`
2. The frontend constructed a `ChatMessageResponse` object using these fields
3. Messages appeared in the UI as blank bubbles (no text, no timestamp)

**Why it wasn't caught**:
- The broadcast function was tested for "does it send an event," not "does the event contain all required fields"
- The frontend's WebSocket handler was tested for "does it update state," not "does the rendered message have content"
- No test asserted the full payload shape against what the UI consumer expects

### Bug 5 (CRITICAL): Message Reporter Uses NodeID Instead of WorkspaceID in POST URL

**Location**: `packages/vm-agent/internal/messagereport/reporter.go:sendBatch()`, `packages/vm-agent/internal/server/server.go:defaultWorkspaceScope()`

After Bug 1 was fixed (reporter now properly initialized with project context), the reporter was still unable to deliver messages because it used the **wrong workspace ID** in its HTTP POST URL.

**What went wrong**:
1. The message reporter is initialized at VM boot with `WorkspaceID = defaultWorkspaceScope(cfg.WorkspaceID, cfg.NodeID)`
2. `WORKSPACE_ID` is not set in cloud-init because the workspace doesn't exist when the VM is provisioned
3. `defaultWorkspaceScope()` falls back to `cfg.NodeID`
4. The reporter POSTs to `/api/workspaces/{nodeId}/messages`
5. The API endpoint looks up the workspace in D1 (`WHERE id = nodeId`) — no workspace has that ID — returns 404
6. 404 is not a permanent error (400/401/403), so messages retry until exhaustion and accumulate in the SQLite outbox forever
7. The task runner later creates the workspace with its own UUID (e.g., `ws-abc123`), but the reporter is never informed

**Why it wasn't caught**:
- PR #228 fixed the reporter initialization (Bug 1: not nil) but didn't verify the POST URL contained a valid workspace ID
- The `WORKSPACE_ID` env var is intentionally absent from cloud-init because the workspace is created after node provisioning
- No integration test exercised the complete POST URL path with a real workspace ID
- Unit tests for `sendBatch()` used mock HTTP servers and pre-configured workspace IDs

### Bug 4 (UX): Provisioning State Lost on Navigation

**Location**: `apps/web/src/pages/ProjectChat.tsx`

When a user submitted a task, the UI showed a live provisioning progress indicator. If the user navigated to another page and then back, the progress indicator disappeared.

**What went wrong**:
1. `ProvisioningState` was stored in ephemeral React component state (`useState`)
2. Navigating away unmounted the component
3. On return, the component re-rendered with no knowledge of the in-progress provisioning
4. Only a static task embed card was shown, with no indication that provisioning was still happening

**Why it wasn't caught**:
- Frontend tests rendered components in isolation without navigation
- No test exercised "submit task → navigate away → navigate back → assert provisioning indicator restored"

---

## Timeline

- **2026-02-28**: Task Durability Framework (TDF) merged with task chat architecture (spec 021)
- **2026-02-28**: Initial prompt delivery bug discovered and fixed (agent never received task description)
- **2026-03-01**: End-to-end task execution tested — agent works but messages don't reach UI
- **2026-03-01**: Investigation reveals all four bugs through code path tracing

---

## Why It Wasn't Caught

### 1. No End-to-End Capability Test for Message Relay

The message relay path crosses three system boundaries:

```
VM Agent → HTTP POST → API Worker → ProjectData DO → WebSocket → Frontend
```

Each boundary was tested in isolation:
- VM agent tests verify messages are enqueued and POSTed
- API tests verify batch persistence and DO method calls
- DO tests verify SQLite insertion and WebSocket broadcast calls
- Frontend tests verify WebSocket event handling updates state

But no test exercised the complete path from agent output to browser rendering. A capability test would have immediately revealed that messages never appear in the UI.

### 2. Broadcast Event Type Mismatch Went Undetected

When `persistMessageBatch()` was implemented, it added a new `messages.batch` broadcast event type. The frontend's `useChatWebSocket` hook was never updated to handle this new event type. This is a classic example of "producer-consumer contract drift":

- The DO (producer) added a new event type
- The frontend (consumer) was never told about it
- Each side passes its own tests in isolation
- The system fails when integrated

No test verified: "for every event type the DO can broadcast, does the frontend have a handler?"

### 3. Cloud-Init Integration Assumptions Were Never Verified

The cloud-init template correctly handles `PROJECT_ID` and `CHAT_SESSION_ID` when provided. Tests verify the template substitution logic. But no test verified that the **calling code** actually passes these variables when provisioning task nodes.

This is a gap between "the integration point works" and "the caller uses the integration point correctly."

### 4. Payload Shape Assertions Were Too Shallow

Tests verified that broadcasts happen and that event handlers are called, but didn't assert the full shape of the data flowing through the system. A broadcast test might check `event.type === 'message.new'` without checking that `event.data.content` exists and is non-empty. A handler test might check that state updates without checking that the state contains renderable data.

### 5. Navigation State Persistence Was Not Considered in Testing

Frontend tests mounted components in isolation. No test exercised the user journey: submit task → see provisioning → navigate away → navigate back. This type of "interrupted flow" testing would have caught the lost state.

---

## Class of Bug

**Cross-boundary data flow gaps**: Each component worked correctly in isolation, but the data flow from producer to consumer was broken at multiple handoff points:

1. Control plane didn't pass required data to cloud-init (caller → integration point gap)
2. DO broadcast a new event type that the frontend didn't handle (producer → consumer contract drift)
3. DO broadcast incomplete data that the frontend couldn't render (payload shape mismatch)
4. Frontend stored ephemeral state that didn't survive navigation (state persistence gap)

This is the **same class** identified in the initial prompt delivery post-mortem (`2026-02-28-missing-initial-prompt-postmortem.md`): "works in unit tests, broken end-to-end."

The recurring pattern:
- Each component passes its tests
- Integration points exist but aren't exercised in realistic scenarios
- Data flows through boundaries without verification of completeness
- The system fails only when all pieces run together

---

## What Should Have Caught This

1. **End-to-end capability test**: Submit task → wait for agent completion → assert messages appear in UI with correct content and timestamps. This single test would have caught bugs 1-3.

2. **WebSocket event handler completeness check**: For every event type the ProjectData DO can broadcast, assert that `useChatWebSocket` has a handler. Ideally enforced by a shared type.

3. **Broadcast payload assertion**: Don't just test that broadcasts happen — assert the full payload structure matches what consumers expect. Test the contract, not just the mechanics.

4. **Cloud-init integration test**: When code passes variables to `generateCloudInit()`, verify the calling code passes the correct values, not just that the template handles them correctly.

5. **Interrupted flow testing**: For user journeys that span navigation, test "start flow → navigate away → navigate back → assert state is restored."

6. **Manual staging test before merge**: Actually submit a task on staging and watch the UI. The absence of messages would have been immediately obvious.

---

## Process Fix

The existing rule `10-e2e-verification.md` already mandates capability tests and data flow tracing. The fact that this class of bug recurred (twice now) indicates enforcement is insufficient.

### Additions to `10-e2e-verification.md`:

1. **WebSocket Event Handler Completeness Check**:
   - When adding a new broadcast event type in a Durable Object, a corresponding handler MUST exist in all WebSocket consumers
   - Verify by test: for each event type in the producer's code, assert the consumer has a handler
   - Ideally enforce with a shared TypeScript union type for event types

2. **Broadcast Payload Shape Assertion**:
   - Tests that verify WebSocket broadcasts MUST assert the full payload shape, not just that an event was sent
   - Use type-safe assertions or schema validation
   - Test the consumer's expectations, not just the producer's output

3. **Integration Point Caller Verification**:
   - When code calls an integration point (e.g., `generateCloudInit()`), a test MUST verify the caller passes correct values
   - Don't only test that the integration point handles inputs correctly — test that it receives correct inputs

4. **Interrupted Flow Testing**:
   - For features involving navigation and ephemeral state, add tests that exercise: start flow → navigate away → navigate back → assert state restored

5. **Dynamic Resource ID Verification**:
   - When a component constructs URLs using resource IDs (workspace ID, node ID, session ID), a capability test MUST verify the URL uses the **correct** ID at runtime — not just that a URL is constructed
   - Specifically: if a resource ID is not available at init time and must be set later, test the complete lifecycle: init with placeholder → set real ID → verify requests use real ID

6. **Capability Test Evidence Requirement**:
   - PRs touching cross-boundary features MUST include evidence of a passing capability test that exercises the complete flow
   - The test must assert the user-visible outcome (messages appear in UI), not just intermediate states (messages persisted to DB)

---

## Fixes Applied

All four bugs were fixed in the same PR:

### Fix 1: Pass Project Context to Cloud-Init for Task Nodes

**File**: `apps/api/src/services/nodes.ts`

Modified `provisionNode()` to accept optional `projectId` and `chatSessionId` parameters and pass them to `generateCloudInit()`:

```typescript
export async function provisionNode(
  env: Env,
  config: ProvisionNodeConfig,
  projectId?: string,
  chatSessionId?: string
): Promise<Node> {
  // ...
  const cloudInitScript = generateCloudInit({
    // ...
    projectId,
    chatSessionId,
  });
  // ...
}
```

Auto-provisioned task nodes now receive project context; manually created nodes (via "New Workspace" UI) continue to work with no message reporter.

### Fix 2: Handle `messages.batch` WebSocket Events in Frontend

**File**: `apps/web/src/hooks/useChatWebSocket.ts`

Added handler for `messages.batch` event type:

```typescript
if (data.event === 'messages.batch') {
  const batchData = data.data as { 
    sessionId: string; 
    messages: ChatMessageResponse[] 
  };
  
  if (batchData.sessionId === currentSessionId) {
    setChatMessages(prev => [...prev, ...batchData.messages]);
  }
}
```

Batch messages now appear in the UI immediately when received.

### Fix 3: Include Full Message Data in `message.new` Broadcasts

**File**: `apps/api/src/durable-objects/project-data.ts`

Modified `broadcastMessageCreated()` to include `content`, `createdAt`, and other message fields:

```typescript
private broadcastMessageCreated(sessionId: string, message: ChatMessageResponse) {
  this.broadcast({
    event: 'message.new',
    data: {
      sessionId,
      messageId: message.id,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      // ... all other fields
    },
  });
}
```

Individual messages (when created outside of batch operations) now render correctly.

### Fix 4: Restore Provisioning Indicator on Navigation Return

**File**: `apps/web/src/pages/ProjectChat.tsx`

Modified provisioning state detection to check both ephemeral React state and the task's actual status:

```typescript
const activeProvisioning = 
  provisioningState ||
  (selectedTask?.status === 'delegated' && selectedTask.workspaceId)
    ? { /* derive from task */ }
    : undefined;
```

When returning to a session with an in-progress task, the component now checks the task status and reconstructs the provisioning indicator.

### Fix 5: Dynamically Update Reporter WorkspaceID After Workspace Creation

**Files**: 
- `packages/vm-agent/internal/messagereport/reporter.go`
- `packages/vm-agent/internal/server/workspaces.go`

Added `SetWorkspaceID(id string)` method to the Reporter (following the existing `SetToken` pattern), with a mutex-protected `workspaceID` field read by `sendBatch()`. When the workspace ID is empty, `sendBatch()` returns a non-permanent error so messages stay in the outbox for retry rather than being discarded.

Called `SetWorkspaceID()` from `handleCreateWorkspace` in the VM agent server, which is invoked by the task runner after workspace creation. Messages enqueued before workspace creation are retained and delivered on the next flush cycle.

```go
func (r *Reporter) SetWorkspaceID(id string) {
    if r == nil { return }
    r.mu.Lock()
    r.workspaceID = id
    r.mu.Unlock()
}
```

### Additional Fix: Enrich Task Embed with Output Summary

**Files**: 
- `apps/api/src/durable-objects/project-data.ts` (schema)
- `apps/web/src/components/chat/ChatMessageList.tsx` (UI)

Added `errorMessage` and `outputSummary` fields to `ChatSessionTaskEmbed` so completed/failed tasks show meaningful context without requiring users to open the workspace.

---

## Lessons for Future Work

1. **Capability tests are mandatory, not optional**: Component tests prove components work. Only capability tests prove the system works. Every feature touching multiple boundaries needs at least one test of the complete happy path.

2. **Test producer-consumer contracts, not just mechanics**: Don't just test "broadcast happens" — test "consumer receives and can use what producer sends."

3. **Verify callers, not just callees**: When testing integration points, test both sides: the integration point handles inputs correctly AND the caller provides correct inputs.

4. **WebSocket event types should be shared types**: If the DO and frontend both reference event types, use a shared TypeScript union or enum to prevent drift.

5. **Test interrupted flows, not just happy paths**: Users navigate away mid-flow. Test that state survives navigation or is correctly restored.

6. **Manual testing is required before merge**: No amount of automated testing substitutes for actually using the feature on staging. If messages don't appear, it's immediately obvious to a human — automated tests can miss it.

7. **Data flow tracing must cite both ends**: When documenting a flow like "VM agent sends messages to UI," cite the sending code AND the receiving code. If you can't cite both, one end doesn't exist.

---

## Related Post-Mortems

- `2026-02-28-missing-initial-prompt-postmortem.md` — Initial prompt never sent to agent (same "works in isolation, broken end-to-end" class)
- `2026-03-01-new-chat-button-postmortem.md` — Click handler and useEffect race condition (interaction-effect analysis rule)

All three post-mortems stem from the same root cause: **insufficient end-to-end verification**. Each component works, the system doesn't, and tests don't catch it because they test components, not capabilities.
