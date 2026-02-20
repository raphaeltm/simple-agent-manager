# Feature Specification: Dashboard Chat Session Navigation

**Feature Branch**: `017-dashboard-chat-navigation`
**Created**: 2026-02-20
**Status**: Paused
**Paused Reason**: During clarification, identified a prerequisite architectural shift — projects as first-class entities with per-project D1 databases. Chat history persistence and high-throughput data surfaces need the project-centric database architecture to be designed first. See forthcoming project-first architecture spec.
**Input**: User description: "Direct navigation to active chat sessions from the main dashboard with session identification, activity reporting, and lightweight chat view"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - View Active Chat Sessions from Dashboard (Priority: P1)

A user has multiple workspaces running with agent chat sessions in progress. They open the main dashboard and immediately see a list of their active chat sessions — each identified by a meaningful topic (derived from the first message they sent in that conversation). They can see at a glance which sessions need their attention (e.g., the agent is waiting for input or approval) versus which are actively working.

**Why this priority**: This is the foundational capability. Without surfacing session state on the dashboard, none of the other stories are possible. It removes the need to "guess and check" which workspace has an active conversation.

**Independent Test**: Can be fully tested by creating multiple workspaces with chat sessions, navigating to the dashboard, and verifying that all active sessions appear with correct topics, statuses, and workspace context.

**Acceptance Scenarios**:

1. **Given** a user has 3 running workspaces, each with 1-2 active chat sessions, **When** they load the dashboard, **Then** they see all active sessions listed with their topic, status indicator, and associated workspace name.
2. **Given** a user has a session where the agent is waiting for tool approval (prompting state), **When** they view the dashboard, **Then** that session is visually elevated or highlighted to indicate it needs attention.
3. **Given** a user has a session that was active 20 minutes ago but the VM agent has not reported recently, **When** they view the dashboard, **Then** that session shows a "stale" indicator so the user knows the state may be outdated.
4. **Given** a user has no active chat sessions, **When** they view the dashboard, **Then** they see an appropriate empty state (e.g., "No active chat sessions").

---

### User Story 2 - Jump Directly Into a Chat Conversation (Priority: P1)

A user sees an active session on the dashboard and clicks/taps it. They are taken directly into a lightweight chat view where they can see the full conversation history and send messages — without loading the full workspace UI (no file browser, no terminal, no sidebar).

**Why this priority**: This is the core value proposition — reducing friction to interact with an agent. Tied with Story 1 because seeing sessions without being able to act on them delivers incomplete value.

**Independent Test**: Can be fully tested by clicking a session from the dashboard, verifying the chat view loads with conversation history, sending a message, and confirming the agent receives and responds to it.

**Acceptance Scenarios**:

1. **Given** a user clicks an active session from the dashboard, **When** the chat view loads, **Then** they see the full conversation history (replayed from the agent's message buffer) and a message input field.
2. **Given** a user is in the lightweight chat view, **When** they type a message and send it, **Then** the agent receives the prompt and responds, with the response streaming in real-time.
3. **Given** a user is in the lightweight chat view, **When** they want more context (file browser, terminal), **Then** they can navigate to the full workspace view via a clearly visible link/button.
4. **Given** a user opens the chat view for a session that has been stopped since they last saw the dashboard, **When** the view loads, **Then** they see an appropriate message indicating the session is no longer active, with an option to navigate to the workspace.

---

### User Story 3 - Automatic Session Topic Identification (Priority: P2)

When a user starts a new chat session and sends their first message, the system automatically captures and stores a "topic" for that session — derived from the first message content. This topic is the primary identifier for the session across the dashboard and chat views, removing the need for users to manually name every session.

**Why this priority**: Session identification is critical for the dashboard to be useful, but it builds on the reporting infrastructure from Story 1. Without meaningful session identification, the dashboard would show a list of opaque session IDs.

**Independent Test**: Can be fully tested by starting a new chat session, sending a first message like "Fix the login page CSS overflow bug", and verifying the session appears on the dashboard with topic "Fix the login page CSS overflow bug".

**Acceptance Scenarios**:

1. **Given** a user starts a new chat session and sends the message "Refactor the authentication middleware to use JWT tokens", **When** the dashboard refreshes, **Then** the session is listed with a topic matching that first message (truncated if necessary).
2. **Given** a session already has an auto-derived topic, **When** the user manually renames the session label, **Then** the label takes display priority over the auto-topic everywhere.
3. **Given** a session's first message is very long (over 200 characters), **When** the topic is captured, **Then** it is truncated at a reasonable boundary (word break) with an ellipsis.
4. **Given** a session was created but no message was ever sent (user selected agent but hasn't prompted yet), **When** the dashboard displays this session, **Then** it shows a fallback identifier such as "New session" with relative time context.

---

### User Story 4 - Session Activity Stays Current Without Manual Refresh (Priority: P2)

As agents work on tasks, the dashboard stays reasonably up to date with session activity — showing when sessions transition between states (idle, working, waiting for input). The user does not need to manually refresh to see state changes, though a small delay (under 2 minutes) is acceptable.

**Why this priority**: Real-time awareness of session state is what makes the dashboard genuinely useful versus just a static list. Without it, users would still need to click into each session to check its state.

**Independent Test**: Can be fully tested by watching the dashboard while an agent session transitions through states (idle -> prompting -> ready) and verifying the dashboard reflects these changes within the acceptable delay.

**Acceptance Scenarios**:

1. **Given** a user is viewing the dashboard, **When** one of their sessions transitions from "ready" to "prompting", **Then** the dashboard updates to reflect this within 2 minutes without manual refresh.
2. **Given** a session was actively prompting, **When** the agent finishes and returns to ready state, **Then** the dashboard shows the updated status within 2 minutes.
3. **Given** a workspace is stopped (shutting down all sessions), **When** the dashboard refreshes, **Then** sessions from that workspace are no longer shown in the active list.

---

### User Story 5 - Session State Reporting from Agent Host to Control Plane (Priority: P1)

The system that runs agent processes reports session state changes to the central control plane so that session status, topic, and activity data are available without requiring the user's browser to connect directly to each workspace host. This reporting happens automatically on state transitions and periodically as a heartbeat for active sessions.

**Why this priority**: This is the enabling infrastructure for all other stories. Without centralized session state, the dashboard cannot show session information without making N+1 calls to individual workspace hosts — which is unscalable and fragile.

**Independent Test**: Can be fully tested by starting an agent session, verifying the control plane database reflects the session's live state (host status, agent type, topic), and confirming periodic updates keep the data fresh.

**Acceptance Scenarios**:

1. **Given** an agent session transitions to "prompting" state on the host, **When** the state change occurs, **Then** the control plane receives and stores the updated host status within a configurable interval.
2. **Given** an active session has not changed state in 60 seconds, **When** the periodic sync fires, **Then** the control plane receives a keep-alive report confirming the session is still active and updating the "last reported" timestamp.
3. **Given** the host stops reporting (e.g., VM crash or network issue), **When** the last report timestamp exceeds a configurable staleness threshold, **Then** the control plane marks the session data as stale for consumers.
4. **Given** a session's first user prompt is captured as the topic, **When** the next sync fires, **Then** the topic text is included in the report and stored on the control plane.

### Edge Cases

- What happens when a workspace VM crashes mid-session? The session data goes stale after the reporting threshold. The dashboard shows a stale indicator. The session's last known state is preserved in the control plane until the workspace is explicitly stopped or deleted.
- What happens when two browser tabs have the same chat session open (one from dashboard, one from workspace view)? Both viewers connect as separate real-time viewers to the same session. Both see the same conversation in real-time. Either can send messages.
- What happens when the user opens a chat view but the workspace has been stopped since the dashboard loaded? The real-time connection to the workspace fails. The chat view shows a clear error state with the option to restart the workspace or go back to the dashboard.
- How does the system handle a user with 50+ active sessions? The session list uses pagination and defaults to showing the most recently active sessions first. Filtering by status (e.g., "needs attention") helps users find what matters.
- What happens when the user's browser is offline and comes back? The dashboard re-fetches session data on visibility change or reconnection. Sessions that changed state during the offline period are shown with their current state.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST provide a centralized view of all active chat sessions across all of a user's workspaces on the main dashboard.
- **FR-002**: Each session in the dashboard list MUST display a meaningful identifier — either a user-set label or an auto-derived topic from the first user message.
- **FR-003**: Each session in the dashboard list MUST display its current activity state (e.g., idle, starting, working, waiting for input, error, stale).
- **FR-004**: Each session MUST display minimal workspace context (workspace name) so the user knows where the session is running.
- **FR-005**: Users MUST be able to click/tap a session to navigate directly to a lightweight chat view for that session.
- **FR-006**: The lightweight chat view MUST display the full conversation history and allow the user to send messages and receive streamed responses.
- **FR-007**: The lightweight chat view MUST NOT include the full workspace UI (no file browser, no terminal, no tab strip, no sidebar).
- **FR-008**: The lightweight chat view MUST provide navigation to the full workspace view for users who need additional workspace tools.
- **FR-009**: The system MUST automatically capture the first user prompt text as the session "topic" when no label has been manually set.
- **FR-010**: A manually set session label MUST take display priority over the auto-derived topic.
- **FR-011**: The agent host MUST report session state changes (host status, agent type, viewer count, topic) to the control plane.
- **FR-012**: The agent host MUST send periodic keep-alive reports for active sessions at a configurable interval.
- **FR-013**: The control plane MUST track the freshness of session reports and expose a staleness indicator when reports stop arriving beyond a configurable threshold.
- **FR-014**: The system MUST provide a cross-workspace session listing capability that returns sessions enriched with workspace context, supporting filtering and pagination.
- **FR-015**: The dashboard MUST visually differentiate sessions that need user attention (e.g., prompting state) from those that are actively working or idle.
- **FR-016**: The auto-derived topic MUST be truncated at a configurable maximum length, breaking at word boundaries.
- **FR-017**: All configurable values (sync interval, staleness threshold, topic max length, page sizes) MUST be environment-driven with sensible defaults.

### Key Entities

- **Agent Session (enriched)**: Extends the existing session record with additional fields: topic (auto-derived conversation identifier), host status (granular live state from agent host), agent type (which agent is running), viewer count (connected browsers), last prompt timestamp, and last reported timestamp (for staleness detection).
- **Session Activity Report**: A periodic or event-driven update from the agent host to the control plane, containing the current state of one or more sessions on that host. Includes host status, agent type, viewer count, topic, and last prompt time.
- **Session Topic**: A short text (up to configurable max length) derived from the first user message in a conversation. Serves as the default human-readable identifier for a session when no explicit label is set.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can identify and navigate to any active chat session from the dashboard in under 5 seconds (2 clicks or taps maximum: dashboard load + session click).
- **SC-002**: Session state changes (idle to prompting, prompting to ready) are reflected on the dashboard within 2 minutes of the transition occurring.
- **SC-003**: 90% of sessions display a meaningful topic identifier (auto-derived from first message) rather than a generic fallback within 10 seconds of the first user prompt.
- **SC-004**: The lightweight chat view loads the conversation history and becomes interactive (user can type and send) within 5 seconds of navigation.
- **SC-005**: Users with 10+ active sessions across multiple workspaces can find a specific session (by topic or status filter) within 10 seconds.
- **SC-006**: The feature works on mobile devices (375px+ viewport) with all interactive elements meeting minimum 56px touch targets and no horizontal scroll required.

## Assumptions

- Users typically have 1-5 active workspaces, with 1-3 active sessions per workspace. The design optimizes for this range while supporting larger numbers through pagination.
- A ~2 minute delay for dashboard state updates is acceptable. Users needing real-time interaction will click into the session, where they get instant responsiveness.
- The first user message in a conversation is a reasonable proxy for the session "topic". More sophisticated summarization (e.g., LLM-generated titles) is a future enhancement.
- The lightweight chat view uses the same real-time connection mechanism as the full workspace view — it is not a separate communication path, just a reduced UI surface.
- Session activity reports are best-effort. Network issues between the agent host and control plane may cause temporary staleness, which is surfaced to the user rather than hidden.
