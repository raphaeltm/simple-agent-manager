# Feature Specification: DO-Owned ACP Session Lifecycle

**Feature Branch**: `027-do-session-ownership`
**Created**: 2026-03-11
**Status**: Draft
**Input**: Architectural shift — make Durable Objects the source of truth for ACP session lifecycle, with VM agents as executors. Enables multi-VM orchestration, session continuity after VM death, and session forking when ACP history injection is not available.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Resilient Task Execution (Priority: P1)

As a user, I submit a task and the system provisions a VM and runs an agent on it. If the VM crashes or is recycled, the system knows the session was interrupted and can surface that state to me — rather than the session silently disappearing.

**Why this priority**: This is the foundational change. Without DO-owned session state, VM death means total session state loss. Every other story depends on the DO being the authoritative record.

**Independent Test**: Submit a task, verify session record exists in DO with correct state machine transitions (pending → assigned → running). Simulate VM failure and verify DO marks session as "interrupted" rather than leaving it in "running" forever.

**Acceptance Scenarios**:

1. **Given** a user submits a task, **When** the DO creates the session and provisions a VM, **Then** the session state transitions through pending → assigned → running, all tracked in the DO.
2. **Given** a running session on a VM, **When** the VM becomes unreachable (crash, network failure, warm pool recycling), **Then** the DO detects the failure and marks the session as "interrupted" within a bounded time.
3. **Given** an interrupted session, **When** the user views the project chat, **Then** they see the session marked as interrupted with the last known messages preserved.
4. **Given** a running session, **When** the VM agent reports completion, **Then** the DO transitions the session to "completed" and records final state.

---

### User Story 2 - Session Forking for Continuity (Priority: P2)

As a user, I want to send follow-up messages to a completed or interrupted task. If the original VM is gone, the system creates a new session ("fork") with context pulled from the original conversation, clearly indicating it is a new session rather than a direct continuation.

**Why this priority**: Session continuity is the primary user-facing improvement. Without it, users must manually re-explain context when re-engaging with a task whose VM is gone.

**Independent Test**: Complete a task (or simulate interruption), destroy the workspace, then attempt to send a follow-up. Verify a new session is created with context from the original, and the UI clearly marks it as a fork.

**Acceptance Scenarios**:

1. **Given** a completed session whose workspace is still alive, **When** the user sends a follow-up message, **Then** the message is delivered to the existing ACP session on the same VM (no fork).
2. **Given** a completed session whose workspace is gone, **When** the user sends a follow-up message, **Then** the system creates a new session (fork), provisions a new VM, and starts a new ACP session with context summarized from the original conversation.
3. **Given** a forked session, **When** the user views the chat, **Then** the UI clearly indicates where the fork occurred (e.g., "Continued from previous session" divider) and the fork lineage is visible.
4. **Given** a session with multiple forks, **When** the user views session history, **Then** the full lineage (parent → child → grandchild) is navigable.

---

### User Story 3 - Workspace-Project Binding (Priority: P1)

As a user, every workspace that runs an ACP session must belong to a project. This ensures there is always a ProjectData DO to own the session lifecycle.

**Why this priority**: This is a structural prerequisite for DO-owned sessions. Without it, ACP sessions on orphan workspaces would have no DO to own them.

**Independent Test**: Attempt to create a workspace with an ACP session without a project — verify it is rejected. Create a workspace tied to a project — verify ACP sessions can be started.

**Acceptance Scenarios**:

1. **Given** a user creates a workspace for a repository, **When** they do not select or create a project, **Then** the workspace is created as a "bare" workspace (PTY-only, no ACP sessions allowed).
2. **Given** a user creates a workspace tied to a project, **When** they start an ACP session, **Then** the session is created in the project's DO and assigned to the workspace's VM.
3. **Given** a bare workspace (no project), **When** the user attempts to start an ACP session, **Then** the system prompts them to associate the workspace with a project first.
4. **Given** a workspace tied to a project, **When** the project is viewed, **Then** all sessions running on that workspace appear in the project's session list.

---

### User Story 4 - VM Agent as Executor (Priority: P2)

As a platform operator, the VM agent should be simplified to an executor role — it receives session assignments from the control plane, runs the ACP SDK, and reports back. It does not own the session state machine.

**Why this priority**: Simplifying the VM agent reduces Go complexity and moves orchestration logic to TypeScript DOs where it's easier to iterate. Also enables the VM agent to reconcile on restart.

**Independent Test**: Restart a VM agent while a session is "assigned" to it. Verify it queries the control plane for active assignments and resumes execution.

**Acceptance Scenarios**:

1. **Given** the control plane assigns a session to a VM agent, **When** the VM agent starts the ACP SDK, **Then** it reports the ACP session ID back to the DO via the API.
2. **Given** a VM agent restarts, **When** it comes back online, **Then** it queries the API for sessions assigned to its node and reconciles (resumes running sessions, reports errors for failed ones).
3. **Given** a VM agent cannot reach the control plane API, **When** it attempts to start an ACP session, **Then** it fails fast and reports the error rather than starting a session that can't report back.
4. **Given** the VM agent successfully starts an ACP session, **When** messages are produced, **Then** they flow through the existing outbox pattern (local SQLite → batch POST → DO persistence).

---

### User Story 5 - Session Tree for Sub-Agent Orchestration (Priority: P3)

As a user, I can see the full session tree when a task delegates subtasks. Each subtask may run on a different VM, but the DO tracks the parent-child relationships and surfaces them in the UI.

**Why this priority**: This is the future payoff of DO-owned sessions. Not fully implemented in v1, but the data model must support it from the start.

**Independent Test**: Create a session with a `parentSessionId` via the API. Verify the DO tracks the relationship and the UI can display the tree.

**Acceptance Scenarios**:

1. **Given** a running session, **When** it creates a subtask (via MCP in the future), **Then** the DO creates a child session with `parentSessionId` linking to the original.
2. **Given** a session with children, **When** the user views the session, **Then** the UI shows the session tree (parent + children) with status for each.
3. **Given** a child session completes, **When** the parent session is still running, **Then** the DO can notify the parent session's VM of the child's completion.

---

### Edge Cases

- What happens when a VM agent receives a "start session" command for a session the DO has already marked as "interrupted" (race condition during VM failure detection)?
- What happens when the DO assigns a session to a VM that has just entered the warm pool and is about to be destroyed?
- What happens when a fork is requested but the original session's messages are very large (context window limits for the summary)?
- What happens when two users attempt to fork the same session simultaneously?
- How does the system handle a VM agent that reports success but the DO never receives the callback (network partition)?
- What happens to in-flight messages in the outbox when a session transitions to "interrupted"?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST track all ACP session state in the ProjectData Durable Object, including status, assigned VM, ACP session ID, timestamps, and fork lineage.
- **FR-002**: System MUST enforce that ACP sessions can only be created for workspaces that are tied to a project.
- **FR-003**: System MUST implement a session state machine in the DO: pending → assigned → running → completed/failed/interrupted, with a "forked" creation path.
- **FR-004**: System MUST detect VM failure (crash, unreachable, warm pool recycling) and transition affected sessions to "interrupted" within a bounded detection window.
- **FR-005**: System MUST support session forking — creating a new session with context derived from an original session's stored messages when the original workspace is gone.
- **FR-006**: System MUST NOT inject chat history into ACP sessions (unsupported by ACP SDK). Forked sessions start fresh with a context summary as the initial prompt.
- **FR-007**: VM agent MUST verify control plane reachability before starting any ACP session. If unreachable, it MUST fail fast and report the error.
- **FR-008**: VM agent MUST reconcile with the control plane on restart — querying for sessions assigned to its node and resuming or reporting errors.
- **FR-009**: System MUST preserve the existing message outbox pattern (local SQLite → batch POST → DO persistence) for crash-safe message delivery.
- **FR-010**: System MUST track session parent-child relationships via `parentSessionId` to support future sub-agent orchestration.
- **FR-011**: The UI MUST clearly indicate session state (running, completed, interrupted, forked) and fork lineage.
- **FR-012**: PTY sessions MUST remain VM-agent owned with no DO involvement (no change to interactive terminal behavior).
- **FR-013**: Bare workspaces (no project association) MUST still be creatable for PTY-only manual development use.
- **FR-014**: System MUST log structured diagnostics at every state transition, including all relevant IDs (sessionId, workspaceId, nodeId, projectId).

### Key Entities

- **ACP Session (DO-owned)**: The authoritative record of an agent coding session. Tracks state machine, assigned VM, ACP SDK session ID, fork lineage (`parentSessionId`), and all messages. Lives in ProjectData DO's SQLite.
- **Session Execution (VM-agent local)**: A lightweight cache of sessions currently being executed by this VM agent. Used for fast lookups and ACP SDK reconnection. Not authoritative — reconciled from DO on restart.
- **Session Fork**: A new ACP session created from an existing session's context. Links back to the original via `parentSessionId`. Contains a context summary derived from the parent's messages.
- **Bare Workspace**: A workspace without a project association. Supports PTY sessions only. Cannot run ACP sessions until associated with a project.
- **Project Workspace**: A workspace tied to a project. All ACP sessions are owned by the project's DO. Supports both PTY and ACP sessions.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: When a VM hosting a running session becomes unreachable, the session is marked as "interrupted" in the DO within 5 minutes (configurable detection window).
- **SC-002**: Users can fork an interrupted or completed session and receive a new session with relevant context within the same time it takes to start a fresh task (no additional overhead beyond context summarization).
- **SC-003**: VM agent restart reconciliation completes within 30 seconds — all sessions assigned to the node are either resumed or reported as errored.
- **SC-004**: 100% of ACP sessions have a corresponding DO record from the moment of creation (no orphan sessions that exist only in VM agent memory).
- **SC-005**: Session state is never lost due to VM failure — all messages delivered to the DO before the failure are preserved, and the session's last known state is accurate.
- **SC-006**: The UI clearly communicates session state transitions — users report understanding of interrupted vs. completed vs. forked states in usability testing.
- **SC-007**: The session data model supports parent-child relationships from day one, verified by creating sessions with `parentSessionId` and querying the tree structure.

## Assumptions

- ACP SDK does not and will not support injecting chat history into a new session in the near term. Forking with a context summary is the pragmatic approach.
- Cloudflare Durable Objects' single-threaded execution model is sufficient for session state management (no concurrent state corruption risk).
- The existing message outbox pattern (VM agent SQLite → API → DO) is reliable enough that messages in transit during VM failure are acceptable losses (they were in the outbox but not yet flushed). The DO's record up to the last successful flush is the preserved state.
- VM failure detection will rely on a combination of heartbeat/health checks and the existing NodeLifecycle DO alarm mechanism, not on the ACP session system itself.
- The warm node pool lifecycle (active → warm → destroying) already provides signals that can be used for session interruption detection.
- Bare workspaces (PTY-only, no project) represent a small minority of use cases and do not need full feature parity with project workspaces.
