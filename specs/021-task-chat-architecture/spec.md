# Feature Specification: Task-Driven Chat Architecture & Autonomous Workspace Execution

**Feature Branch**: `021-task-chat-architecture`
**Created**: February 24, 2026
**Status**: Draft
**Input**: Re-architect message persistence so the VM agent (not the browser) persists chat messages to the ProjectData Durable Object, and build a project-level task/chat experience where users can submit tasks that auto-provision workspaces, execute autonomously, and persist full chat history.

## Clarifications

### Session 2026-02-24

- Q: Should chat history have a retention/cleanup policy, or persist indefinitely? → A: Keep all messages forever (no retention limit). Future consideration: add cleanup or (paid feature) compaction as a separate feature if storage becomes an issue.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Agent-Side Chat Persistence (Priority: P1)

A user interacts with an AI agent through a workspace. As messages flow between the user and the agent, the VM agent — not the browser — persists every message to the project's persistent store. If the user closes their browser, switches tabs, or loses connectivity, no messages are lost. When they return to the project page later (even after the workspace is destroyed), the full chat history is available.

**Why this priority**: This is the foundational architecture fix. The current model where the browser persists messages is broken for any async or headless workflow. Every other feature in this spec depends on reliable server-side message persistence. Without it, autonomous task execution cannot record its work, and project-level chat history is incomplete.

**Independent Test**: Start a workspace, send messages to the agent, close the browser entirely, reopen the project page, and verify all messages (both user and assistant, including tool metadata) are present in the session history.

**Acceptance Scenarios**:

1. **Given** a workspace with a project association is running, **When** the user sends a message and the agent responds, **Then** both messages are persisted to the project's persistent store by the VM agent without any browser involvement.
2. **Given** a user closes their browser while an agent is actively generating a response, **When** the agent finishes responding, **Then** the response is still persisted because the VM agent handles persistence independently.
3. **Given** a workspace is destroyed after a session completes, **When** the user navigates to the project page, **Then** the full chat history from that workspace's sessions is available, including message content, roles, timestamps, and tool call metadata.
4. **Given** a workspace has no project association (legacy or orphaned), **When** the user interacts with the agent, **Then** the system gracefully skips project-level persistence without errors (messages are still available via direct workspace connection).
5. **Given** the VM agent cannot reach the persistence endpoint (network error, API downtime), **When** messages are generated, **Then** the agent buffers messages locally and retries persistence, ensuring no data loss for transient failures.

---

### User Story 2 - Submit a Task and Run It Immediately (Priority: P1)

A user opens a project page and sees a chat-style input at the bottom. They type a task description (e.g., "Fix the login timeout bug in auth.ts") and click "Run Now." The system creates a task, provisions a workspace automatically, and the agent begins working on it. The user sees messages flowing in real-time on the project page as the agent works. When the agent completes the task cleanly, the workspace is automatically destroyed, and all work is committed to a task-linked branch.

**Why this priority**: This is the core user-facing feature — the ability to fire off coding tasks from the project page without manually managing nodes and workspaces. It transforms SAM from a manual workspace manager into an autonomous coding agent platform. Combined with P1 persistence, this delivers the primary value proposition.

**Independent Test**: User types a task on the project page, clicks "Run Now," watches messages appear in real-time, and after completion sees the workspace cleaned up and a git branch with the agent's work.

**Acceptance Scenarios**:

1. **Given** a user is on a project page with valid cloud credentials configured, **When** they type a task description and click "Run Now," **Then** a task is created, a chat session is linked to it, and a workspace begins provisioning immediately.
2. **Given** a task is running and the workspace is provisioning, **When** the user watches the project page, **Then** they see status updates: task queued, workspace provisioning, agent starting, then messages flowing in as the agent works.
3. **Given** the agent completes its work cleanly (ACP session ends normally), **When** completion is detected, **Then** the agent's changes are committed to a branch named with the task identifier, the workspace is automatically destroyed, and the task status transitions to completed.
4. **Given** the agent encounters an error or crashes during execution, **When** the failure is detected, **Then** the workspace is kept alive for user inspection, the task status transitions to failed with an error message, and the user can investigate or retry.
5. **Given** a user manually cancels a running task, **When** the cancellation is processed, **Then** the workspace is kept alive (not destroyed), the task status transitions to cancelled, and the user can resume or inspect.
6. **Given** a task completes and work was committed, **When** the user views the completed task, **Then** they see the output branch name, and optionally a PR URL if the agent created one.

---

### User Story 3 - Project-Level Chat View as Default Experience (Priority: P1)

A user navigates to a project and lands on a chat-first view. A sidebar on the left shows a list of chat sessions (most recent first), and the main panel shows the messages for the selected session. This is the default view — the user sees their most recent conversation immediately. Active sessions show messages appearing in real-time; completed sessions show the full historical transcript.

**Why this priority**: The project page is the most visited surface in the app. Making chat the default view (rather than a workspace list or settings page) puts the most valuable content — agent conversations — front and center. This is where users will spend most of their time: reviewing what agents did, understanding changes, and launching new tasks.

**Independent Test**: Navigate to a project with multiple past sessions, verify the most recent session loads by default, scroll through messages, switch between sessions in the sidebar, and confirm active sessions show real-time message updates.

**Acceptance Scenarios**:

1. **Given** a user navigates to a project with existing chat sessions, **When** the project page loads, **Then** the default view is the chat view with a session list sidebar on the left and the most recent session's messages displayed in the center panel.
2. **Given** multiple chat sessions exist for a project, **When** the user clicks a different session in the sidebar, **Then** the center panel updates to show that session's messages, status, and metadata.
3. **Given** a session is currently active (agent is working), **When** the user views that session on the project page, **Then** messages appear in near-real-time as the agent generates them, without requiring a page refresh.
4. **Given** a session is linked to a task, **When** the user views the session, **Then** the task title, status, and output (branch, PR) are visible in the session header.
5. **Given** a session is from a workspace that has been destroyed, **When** the user views the session, **Then** the full message history is available with a visual indicator that the workspace no longer exists.
6. **Given** a session is from a still-running workspace, **When** the user views the session, **Then** an option to "Open Workspace" is available, navigating them to the live workspace terminal.

---

### User Story 4 - Save Task to Backlog (Priority: P2)

A user types a task description on the project page but chooses "Save to Backlog" from a dropdown on the submit button (similar to GitHub's draft PR dropdown). The task is saved in draft status and appears on the task board. Later, the user can review, edit, prioritize, and run the task when ready.

**Why this priority**: Not every task needs to run immediately. Users need a way to capture ideas, plan work, and batch tasks for later execution. This is essential for task management but secondary to the core submit-and-run flow.

**Independent Test**: User types a task, selects "Save to Backlog" from the dropdown, verifies the task appears in the draft column of the kanban board, edits it, then triggers execution from the board.

**Acceptance Scenarios**:

1. **Given** a user types a task description, **When** they click the dropdown on the submit button and select "Save to Backlog," **Then** the task is created with draft status and no workspace is provisioned.
2. **Given** a task is in draft status on the kanban board, **When** the user clicks on it, **Then** they can edit the title, description, priority, and other metadata.
3. **Given** a user has a draft task they want to execute, **When** they trigger "Run" from the task detail or board, **Then** the task follows the same autonomous execution flow as "Run Now" (workspace provisioned, agent starts, messages persist).
4. **Given** multiple draft tasks exist, **When** the user views the kanban board, **Then** tasks are sorted by priority within each column.

---

### User Story 5 - Task Kanban Board (Priority: P2)

A user switches from the chat view to a kanban board view to see all tasks organized by status. The board shows columns for the primary task statuses, with task cards displaying title, status indicators, and links to their chat sessions. Transient statuses (like provisioning) appear as visual indicators on the cards rather than separate columns.

**Why this priority**: The kanban view provides operational awareness — what's queued, what's running, what's done, what failed. It complements the chat view (which is session-focused) with a task-focused perspective. Important for users managing multiple concurrent tasks.

**Independent Test**: Create several tasks in different statuses, switch to kanban view, verify columns and cards render correctly, click a task card to navigate to its chat session.

**Acceptance Scenarios**:

1. **Given** a project has tasks in various statuses, **When** the user switches to the kanban board view, **Then** they see columns for draft, ready, in_progress, completed, failed, and cancelled statuses.
2. **Given** a task is in a transient status (queued or delegated during provisioning), **When** the user views the board, **Then** the task card shows a visual indicator (spinner or badge) rather than appearing in a separate column — unless those transient columns contain items, in which case the columns are shown.
3. **Given** a task card is displayed, **When** the user reads it, **Then** they see the task title, current status, a workspace status indicator (if active), and a link to the associated chat session.
4. **Given** a user clicks a task card, **When** the navigation occurs, **Then** they are taken to the chat view with that task's linked session selected.
5. **Given** the user is on the chat view, **When** they want to see the kanban board, **Then** they can switch views with a single click (tab or toggle), and switch back just as easily.

---

### User Story 6 - Warm Node Pooling for Fast Task Startup (Priority: P2)

After a task completes and its workspace is destroyed, the underlying node (VM) stays alive for 30 minutes. When the user submits another task during that window, the system reuses the warm node instead of provisioning a new one, dramatically reducing startup time. If no new task arrives within 30 minutes, the node is automatically cleaned up.

**Why this priority**: Node provisioning is the slowest part of task execution (30+ seconds for VM boot). Warm node reuse makes sequential task execution feel fast and responsive. However, the core flow works without it (just slower), so it's P2.

**Independent Test**: Run a task to completion, immediately run another task, verify it reuses the same node (fast startup). Wait 30+ minutes without a new task, verify the node is cleaned up.

**Acceptance Scenarios**:

1. **Given** a task completes and its workspace is destroyed, **When** the node has no remaining active workspaces, **Then** the node enters a 30-minute idle countdown instead of being immediately destroyed.
2. **Given** a node is in the idle countdown period, **When** a new task run is triggered for the same user, **Then** the system selects the warm idle node instead of provisioning a new one.
3. **Given** a node has been idle (no active workspaces) for longer than the configured timeout, **When** the timeout expires, **Then** the node is automatically destroyed and its cloud resources released.
4. **Given** two tasks are submitted simultaneously and only one warm node is available, **When** node selection occurs, **Then** one task gets the warm node and the other provisions a new node (no race condition failures).
5. **Given** the idle timeout duration is configurable, **When** an operator changes the configuration, **Then** newly emptied nodes use the updated timeout value.

---

### User Story 7 - Project-Level Default VM Size (Priority: P3)

A user configures a default VM size (small, medium, or large) at the project level in project settings. When tasks are submitted for autonomous execution, the system uses this default size for provisioning unless the user overrides it for a specific task. This eliminates the need to choose a VM size every time.

**Why this priority**: Sensible defaults reduce friction in the task submission flow. Most projects have a consistent resource need (e.g., a large monorepo always needs a large VM). However, the system works fine with a system-wide default, so project-level configuration is a nice-to-have.

**Independent Test**: Set a project's default VM size to "large," submit a task without specifying size, verify the provisioned node is large. Submit another task with an explicit "small" override, verify that one uses small.

**Acceptance Scenarios**:

1. **Given** a project has no default VM size configured, **When** a task is submitted for autonomous execution, **Then** the system uses the platform default size (small).
2. **Given** a user sets the project's default VM size to "large" in project settings, **When** a task is submitted without specifying a size, **Then** the provisioned node uses the "large" size.
3. **Given** a project has a default VM size, **When** a user submits a task with an explicit size override via advanced options, **Then** the override takes precedence over the project default.
4. **Given** the architecture stores VM size preferences at the project level, **When** future features add per-profile size overrides, **Then** the data model can accommodate profile-level defaults without schema changes.

---

### Edge Cases

- What happens when the VM agent's persistence buffer fills up during an extended API outage? The agent should cap the buffer at a configurable maximum (e.g., 1000 messages) and drop the oldest unpersisted messages with a warning log, prioritizing recent messages.
- What happens when a task run's workspace provisioning fails (e.g., Hetzner API error, quota exceeded)? The task transitions to failed status with an error message describing the provisioning failure. No workspace or node cleanup is needed since nothing was created successfully.
- What happens when the user submits a "Run Now" task but has no cloud provider credentials configured? The system prevents submission and displays a clear error directing the user to configure credentials in project settings.
- What happens when a task's git branch name conflicts with an existing remote branch? The system appends a short suffix to make the branch name unique (e.g., `task/{taskId}-2`) and records the actual branch name in the task output.
- What happens when the user switches between chat view and kanban view rapidly? View state is preserved — the selected session in chat view and scroll position in kanban view are maintained across switches.
- What happens when a workspace completes but the git push fails (e.g., branch protection rules, network error)? The task transitions to completed but with a warning indicating the push failed. The workspace is not destroyed, allowing the user to manually push or inspect.
- What happens when multiple workspaces in the same project are running simultaneously and persisting messages? Each workspace persists to its own chat session within the project's persistent store. Sessions are isolated — no message interleaving occurs.

## Requirements *(mandatory)*

### Functional Requirements

**Message Persistence Architecture**

- **FR-001**: The VM agent MUST persist all chat messages (user turns, assistant turns, and tool call metadata) to the project's persistent store via the control plane API.
- **FR-002**: The browser MUST NOT be responsible for persisting chat messages. The browser's role is read-only: fetching and displaying message history from the persistent store.
- **FR-003**: The VM agent MUST receive its project identifier and chat session identifier as configuration during workspace provisioning.
- **FR-004**: When a workspace has a project association, the VM agent MUST create a chat session in the project's persistent store when an agent session starts, and persist all subsequent messages to that session.
- **FR-005**: When a workspace has no project association, the VM agent MUST skip project-level persistence without errors.
- **FR-006**: The VM agent MUST buffer messages locally and retry persistence on transient API failures, with a configurable maximum buffer size.
- **FR-007**: Agent session identifiers and chat session identifiers MUST be correlated (same ID or linked) so infrastructure state and message content can be cross-referenced.

**Task-to-Chat Session Linkage**

- **FR-008**: Each task MUST be linked to exactly one chat session upon creation. The task's description becomes the first user-role message in that session.
- **FR-009**: The chat session MUST reference the originating task identifier, enabling navigation from session to task and task to session.
- **FR-010**: For manually-created workspaces (not triggered by a task), the system MUST still create and persist chat sessions at the project level.

**Autonomous Task Execution**

- **FR-011**: When a user submits a task with "Run Now," the system MUST create the task, create a linked chat session, and immediately trigger autonomous workspace provisioning.
- **FR-012**: The system MUST select an available warm idle node for the user before provisioning a new node. If no warm node is available, a new node MUST be provisioned.
- **FR-013**: The workspace MUST be configured with a git branch derived from the task identifier (e.g., `task/{taskId}`). The actual branch name MUST be recorded in the task's output metadata.
- **FR-014**: On clean ACP session completion, the system MUST automatically destroy the workspace and transition the task to completed status.
- **FR-015**: On agent failure, crash, or user cancellation, the system MUST keep the workspace alive for inspection and transition the task to the appropriate terminal status (failed or cancelled).
- **FR-016**: Task execution output (branch name, PR URL if created, summary) MUST be recorded on the task entity upon completion.

**Warm Node Pooling**

- **FR-017**: When a workspace is destroyed and its node has no remaining active workspaces, the node MUST enter an idle countdown period instead of being immediately destroyed.
- **FR-018**: The idle countdown duration MUST be configurable with a default of 30 minutes.
- **FR-019**: When a task run requires a node, the system MUST check for idle warm nodes owned by the user before provisioning a new node.
- **FR-020**: Node selection MUST handle concurrent requests safely — two simultaneous task runs MUST NOT both claim the same warm node.
- **FR-021**: When the idle countdown expires without a new workspace being scheduled, the node MUST be automatically destroyed and its cloud resources released.

**Project-Level Chat UI**

- **FR-022**: The project detail page MUST default to the chat view, showing a session list sidebar and a message panel.
- **FR-023**: The session list sidebar MUST display sessions in reverse chronological order (most recent first), showing session topic, status, associated task title (if any), and timestamp.
- **FR-024**: The message panel MUST display all messages for the selected session with role indicators, timestamps, and tool call metadata.
- **FR-025**: For active sessions (agent currently working), the message panel MUST update in near-real-time as new messages are persisted, without requiring page refresh.
- **FR-026**: For sessions linked to a still-running workspace, the UI MUST offer an "Open Workspace" action to navigate to the live workspace terminal.
- **FR-027**: Users MUST be able to switch between chat view and kanban board view with a single action, and switch back without losing view state.

**Task Kanban Board**

- **FR-028**: The kanban board MUST show columns for: draft, ready, in_progress, completed, failed, and cancelled statuses.
- **FR-029**: Transient statuses (queued, delegated) MUST be displayed as visual indicators on task cards rather than as separate columns, unless those statuses contain items — in which case the columns appear dynamically.
- **FR-030**: Task cards MUST display the task title, status, a workspace/execution indicator (if active), and a link to the associated chat session.
- **FR-031**: Clicking a task card MUST navigate to the chat view with the task's linked session selected.

**Task Submission**

- **FR-032**: The project page MUST include a task submission input that supports a split-action submit button: "Run Now" as the primary action and "Save to Backlog" as a dropdown option.
- **FR-033**: "Run Now" MUST create the task, link a chat session, and trigger autonomous execution in a single user action.
- **FR-034**: "Save to Backlog" MUST create the task in draft status with a linked (but inactive) chat session, without provisioning any infrastructure.
- **FR-035**: Advanced options (priority, dependencies, agent profile hint) MUST be available via an expandable section on the submission form, collapsed by default for a streamlined experience.

**Project-Level Settings**

- **FR-036**: Projects MUST support a configurable default VM size (small, medium, large) stored at the project level.
- **FR-037**: When a task is run autonomously without an explicit size override, the system MUST use the project's default VM size. If no project default is set, the platform default (small) is used.
- **FR-038**: The data model for VM size preferences MUST be structured to accommodate future per-profile overrides without schema migration.

**Dual-Channel Real-Time Model**

- **FR-039**: When a user is in the workspace context (connected to the VM agent via direct WebSocket), they MUST receive real-time streamed messages directly from the agent.
- **FR-040**: When a user is on the project page (not directly connected to a VM agent), they MUST receive near-real-time message updates via the persistent store's broadcast mechanism.
- **FR-041**: Both channels MUST coexist — the persistent store is always written to regardless of whether any browser is viewing the session.

### Key Entities

- **Task**: A unit of work submitted by a user, linked to a project. Has a title, description, status (draft through completed/failed/cancelled), priority, and references to its linked chat session, workspace (if executing), output branch, and output PR. Tasks are the initiating concept — they capture user intent and track execution lifecycle.
- **Chat Session**: A conversation record within a project's persistent store. Contains an ordered sequence of messages between the user and the AI agent. Linked to a task (if task-triggered) and a workspace (if originated from one). Persists independently of workspace lifecycle — the session survives workspace destruction.
- **Chat Message**: An individual message within a chat session. Has a role (user or assistant), content, optional tool call metadata, and a timestamp. Persisted by the VM agent, not the browser.
- **Node (with idle state)**: A VM host that runs workspaces. Extended with idle tracking: when all workspaces are removed, the node enters a configurable idle countdown. Idle nodes are preferred for new task runs. Expired idle nodes are automatically cleaned up.
- **Workspace (with auto-lifecycle)**: An AI coding environment on a node. Extended with automatic destruction on clean task completion. Workspace identity includes project and chat session references passed during provisioning.
- **Project Settings**: Per-project configuration including default VM size. Structured to accommodate future per-profile settings without schema changes.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Chat messages are persisted with zero data loss when the user's browser is closed, disconnected, or never opened (autonomous execution). 100% of agent messages from a completed session are retrievable from the project's chat history.
- **SC-002**: Users can submit a task and see agent execution begin within the time it takes to provision infrastructure (no additional manual steps after clicking "Run Now"). The number of user actions to go from "idea" to "agent working" is exactly one click after typing the task description.
- **SC-003**: Chat history for destroyed workspaces is fully accessible from the project page. Users can browse any past session regardless of whether the originating workspace still exists.
- **SC-004**: Warm node reuse reduces subsequent task startup time by at least 50% compared to cold provisioning (skipping the VM boot and agent installation steps).
- **SC-005**: The project page loads and displays the most recent chat session within 2 seconds for projects with up to 100 sessions and 10,000 messages.
- **SC-006**: Task status transitions are reflected in the kanban board and chat view within 5 seconds of the underlying state change.
- **SC-007**: The system supports at least 5 concurrent autonomous task executions per user without degradation in message persistence or status tracking.
- **SC-008**: Users can switch between chat view and kanban view in under 500 milliseconds with no loss of scroll position or selection state.

## Assumptions

- Users have already configured cloud provider credentials (Hetzner API token) in their project/account settings before attempting to run tasks autonomously. The system validates this as a precondition.
- The existing task runner orchestration (node selection, workspace creation, agent session startup, completion callbacks) is functional and can be extended rather than rewritten.
- The existing VM agent callback authentication (JWT with workspace-callback audience) is sufficient for the new message persistence endpoint — no new auth mechanism is needed.
- The ACP SDK provides a reliable signal for "session completed cleanly" that the VM agent can use to trigger the auto-destroy flow. If the session ends without error, it is considered clean completion.
- Git branch creation and push operations are handled by the agent during task execution using the existing git credential helper. The system provides the branch name; the agent is responsible for committing and pushing.
- The project-level chat view replaces the current project detail landing page. Existing navigation to workspaces, settings, and other project features remains accessible but is no longer the default view.
- The 30-minute node idle timeout is a sensible default. The system does not need to learn or adapt the timeout — a static configurable value is sufficient.
- Per-agent-profile VM size overrides and system prompts are a future feature. The current implementation only needs to not block that future by keeping the settings model extensible.
- Chat messages and sessions are retained indefinitely. No automatic cleanup or archival is applied. The data model does not need to account for retention policies in this iteration.

## Dependencies

- **Existing Task Runner**: The autonomous execution flow builds on the existing `POST /tasks/:taskId/run` endpoint and its orchestration logic (node provisioning, workspace creation, agent session management).
- **VM Agent Callback Auth**: Message persistence relies on the existing callback JWT authentication that the VM agent already uses for heartbeats, ready signals, and error reports.
- **ProjectData Durable Object**: Chat session and message storage depends on the existing DO infrastructure with its embedded SQLite and WebSocket broadcast capabilities.
- **Cloud-Init Template**: Passing project and session identifiers to the workspace requires extending the existing cloud-init template that configures the VM agent.
- **ACP SDK Session Lifecycle**: Auto-destroy on clean completion depends on the ACP SDK providing a reliable session-end signal that the VM agent can observe.

## Out of Scope

- **Interactive task control from project page**: Pausing, resuming, or sending follow-up messages to a running agent from the project page (without being in the workspace context) is deferred to a future spec. The architecture should not prevent this, but it is not implemented here.
- **Agent profiles / system prompts**: The concept of different agent "personalities" with custom system prompts and associated VM sizes is a future feature. This spec only ensures the data model is extensible enough to accommodate it.
- **Task scheduling / queue prioritization**: Automated scheduling of backlog tasks (e.g., run the next ready task when a node becomes available) is not included. Tasks are executed on explicit user action ("Run Now" or manual trigger from the board).
- **Cross-project task views**: A global dashboard showing tasks across all projects is not included. Task management is scoped to individual projects.
- **Message search**: Full-text search across chat messages within a project is not included in this spec.
- **Session resumption**: Resuming a completed/stopped chat session by spawning a new workspace with the prior conversation loaded as context is a future feature.
- **Chat history cleanup / compaction**: Automatic retention policies, archival, or paid compaction features for long-lived projects with large message volumes. Messages are retained indefinitely in this iteration.
