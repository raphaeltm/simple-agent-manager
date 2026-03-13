# Feature Specification: Conversation Forking & Context Summarization

**Feature Branch**: `029-conversation-forking`
**Created**: 2026-03-13
**Status**: Draft
**Input**: Enable users to continue work from a completed/stopped session by forking the conversation with an AI-generated context summary.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Continue Work After Workspace Destruction (Priority: P1)

A user submitted a task that an agent completed — the workspace was destroyed after the warm pool timeout expired. The user now wants to iterate on the agent's work (e.g., fix a bug the agent introduced, extend a feature, add tests). Instead of starting from scratch and re-explaining everything, the user clicks "Continue" on the completed session, reviews an AI-generated summary of the conversation, and submits a new task that picks up where the previous one left off.

**Why this priority**: This is the core value proposition. Without this, users must manually re-explain context every time they want to iterate on completed work, which is the most common pain point.

**Independent Test**: Can be fully tested by completing a task, waiting for workspace cleanup, then clicking "Continue" on the stopped session and verifying a new task is created with appropriate context.

**Acceptance Scenarios**:

1. **Given** a completed session with 15+ messages and a destroyed workspace, **When** the user clicks "Continue", **Then** the system generates a structured context summary and displays it in an editable dialog.
2. **Given** the fork dialog is open with a generated summary, **When** the user edits the summary and types a new instruction, **Then** a new task is created with the edited summary as context and the new instruction as the task description.
3. **Given** a new task created from a fork, **When** the workspace provisions, **Then** the new agent starts with the context summary in its initial prompt and checks out the parent task's output branch.
4. **Given** a forked session, **When** the user views the new session, **Then** a visual indicator shows "Continued from [parent session]" with a link back.

---

### User Story 2 - AI-Powered Context Summarization (Priority: P1)

When the user initiates a fork, the system automatically generates a structured summary of the previous conversation. The summary filters out tool call noise, prioritizes recent messages, and produces actionable context that a new agent can use to understand the prior work — including files modified, decisions made, the current state of work, and the output branch.

**Why this priority**: Without intelligent summarization, the user would need to manually write context, which defeats the purpose of the feature. This is tightly coupled to Story 1.

**Independent Test**: Can be tested by calling the summarization service with a session containing diverse message types and verifying the output is structured, filtered, and contains key contextual information.

**Acceptance Scenarios**:

1. **Given** a session with user, assistant, tool, and system messages, **When** summarization is requested, **Then** only user and assistant messages are included in the summary input.
2. **Given** a session with 100+ messages, **When** summarization is requested, **Then** the system applies chunking (keeping first few and most recent messages) to fit within processing limits.
3. **Given** a session where the agent discussed specific files and made decisions, **When** summarization is requested, **Then** the summary includes file paths, key decisions, and current work state in a structured format.
4. **Given** Workers AI is unavailable or times out, **When** summarization is requested, **Then** the system falls back to heuristic extraction (last N messages with role labels + task metadata) rather than failing.

---

### User Story 3 - Fork Lineage Navigation (Priority: P2)

Users can see the relationship between forked sessions. When viewing a session that was forked from another, a visual indicator shows the parent session with a clickable link. This helps users understand the history of their iterative work across multiple sessions.

**Why this priority**: Adds navigational context but is not required for the core forking flow. Users can still fork without lineage visibility.

**Independent Test**: Can be tested by creating a fork chain (session A → B → C) and verifying each session shows its parent link and the lineage is navigable.

**Acceptance Scenarios**:

1. **Given** a session created via fork, **When** the user views it, **Then** a "Continued from" indicator with a link to the parent session is displayed.
2. **Given** a session that has been forked, **When** the user views the parent, **Then** a "Continued in" indicator with a link to the child session is displayed.

---

### User Story 4 - Graceful Degradation (Priority: P2)

The forking flow works even when AI summarization fails. The system falls back to a simpler heuristic extraction that concatenates recent messages with role labels and includes task metadata (title, branch, PR URL). The user can still review and edit this fallback summary before submitting.

**Why this priority**: Ensures the feature is reliable even under AI service degradation, but the happy path (AI summarization) is the primary experience.

**Independent Test**: Can be tested by simulating AI service failure and verifying the fallback produces usable context.

**Acceptance Scenarios**:

1. **Given** Workers AI is unavailable, **When** the user clicks "Continue", **Then** a heuristic summary is generated from the last 10 user+assistant messages plus task metadata.
2. **Given** a heuristic fallback summary, **When** the user reviews it in the fork dialog, **Then** it includes the task title, output branch, and recent conversation excerpts.

---

### Edge Cases

- What happens when a session has only 1-2 messages? The summary should include all messages verbatim without AI processing.
- What happens when a session has no user or assistant messages (only tool/system)? The system should use task metadata (title, description) as the summary fallback.
- What happens when the parent task has no output branch (agent didn't push)? The fork should still work, but the new workspace starts from the default branch.
- What happens when a user tries to fork an active (non-terminal) session? The system should reject the fork with a clear message.
- What happens when fork depth reaches the maximum (10)? The system should display a message explaining the limit has been reached.
- What happens when the user dismisses the fork dialog? No fork or task should be created; the action is cancelled.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide a "Continue" action on sessions in terminal states (completed, failed, interrupted, stopped).
- **FR-002**: System MUST generate a structured context summary from a session's message history, filtering out tool calls, system messages, thinking blocks, and plan blocks.
- **FR-003**: System MUST apply a chunking strategy for long conversations to fit within AI processing limits — keeping the earliest messages for original context and the most recent messages for current state.
- **FR-004**: System MUST present the generated summary to the user in an editable dialog before creating the fork.
- **FR-005**: System MUST allow the user to provide a new task instruction alongside the context summary.
- **FR-006**: System MUST create a new task that includes the context summary in the agent's initial prompt.
- **FR-007**: System MUST provision the new workspace on the parent task's output branch when one exists, falling back to the default branch otherwise.
- **FR-008**: System MUST fall back to heuristic summary extraction when AI summarization fails or times out.
- **FR-009**: System MUST display fork lineage indicators on sessions that were created from or forked into other sessions.
- **FR-010**: System MUST enforce the existing fork depth limit and display a clear message when the limit is reached.
- **FR-011**: All summarization configuration values (model, timeout, max length, max messages, recent message weight) MUST be configurable via environment variables with sensible defaults.
- **FR-012**: System MUST short-circuit AI summarization for very short sessions (≤5 messages after filtering) and include all messages verbatim.

### Key Entities

- **Context Summary**: A structured text representation of a session's conversation history, containing the original task, files discussed, decisions made, current work state, and output branch. Generated by AI with heuristic fallback.
- **Fork Relationship**: A parent-child link between two sessions, tracked via parent session ID and fork depth. Enables lineage navigation and limits chain depth.
- **Summarization Configuration**: Configurable parameters controlling the summarization process — model selection, timeout, output length limits, message count limits, and recent message weighting.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users can initiate a "Continue" flow from a completed session and have a new task running with context within 30 seconds (excluding workspace provisioning time).
- **SC-002**: AI-generated summaries are produced in under 10 seconds for sessions with up to 200 messages.
- **SC-003**: 100% of fork attempts succeed even when AI summarization fails, via heuristic fallback.
- **SC-004**: Context summaries include the output branch name, files mentioned, and current work state in at least 90% of cases where that information exists in the conversation.
- **SC-005**: Users can navigate fork lineage (parent ↔ child) with a single click from any forked session.

## Assumptions

- The existing ACP session fork API (`POST /api/projects/:id/acp-sessions/:sessionId/fork`) provides the correct foundation and does not need architectural changes.
- Workers AI (`@cf/meta/llama-3.1-8b-instruct`) is sufficient for conversation summarization; a larger model is not required.
- The task runner already supports provisioning workspaces on a specific branch via the `output_branch` field.
- Users are comfortable reviewing and editing AI-generated summaries before submitting.
- The 64KB limit on `contextSummary` in the existing fork API is sufficient for all practical summaries.
