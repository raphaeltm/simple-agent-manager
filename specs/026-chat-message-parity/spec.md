# Feature Specification: Chat Message Display Parity

**Feature Branch**: `026-chat-message-parity`
**Created**: 2026-03-09
**Status**: Draft
**Input**: Ensure parity between the information displayed in chat messages in workspaces and projects.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Consistent Tool Call Display (Priority: P1)

As a user viewing an agent session in the project chat view, I see the same tool call information (title, status, content, file locations, diffs) as I would see in the workspace chat view. Tool calls should not appear empty or missing content in one view but populated in the other.

**Why this priority**: Tool calls are the most frequent message type from agents and carry critical information (file edits, command output, search results). Missing or degraded tool call content is the most impactful parity gap.

**Independent Test**: Can be tested by running an agent task that produces tool calls with diffs, terminal output, and text content, then comparing the display in workspace view vs project view.

**Acceptance Scenarios**:

1. **Given** an agent session that produced tool calls with diff content, **When** I view the session in the project chat, **Then** I see the same diff information (file paths, changes) as in the workspace chat.
2. **Given** an agent session that produced tool calls with terminal output, **When** I view the session in the project chat, **Then** terminal content is rendered, not silently hidden.
3. **Given** an agent session that produced tool calls with text content, **When** I view the session in the project chat, **Then** the text content and any fallback data are displayed identically to workspace chat.

---

### User Story 2 - Consistent Plan Rendering (Priority: P2)

As a user viewing a plan created by an agent, I see the same visual treatment (status indicators, entry text, layout) regardless of whether I'm in the workspace chat or project chat.

**Why this priority**: Plans are a prominent visual element that users track for progress. Visual inconsistency erodes trust in the project view as a reliable alternative to the workspace view.

**Independent Test**: Can be tested by triggering a plan from an agent session, then comparing the rendered output side-by-side in both views.

**Acceptance Scenarios**:

1. **Given** an agent session with an active plan, **When** I view the session in the project chat, **Then** the plan entries show the same status indicators (pending/in-progress/completed) and text formatting as the workspace chat.
2. **Given** a plan with completed entries, **When** I view in project chat, **Then** completed entries show strikethrough styling consistent with workspace chat.

---

### User Story 3 - Unknown Message Type Visibility (Priority: P3)

As a user viewing an agent session that produced unknown or unexpected message types, I can see those messages rather than having them silently dropped.

**Why this priority**: While rare, silently dropping messages creates confusion — users may wonder why gaps appear in conversation flow. Rendering them as a fallback maintains debugging visibility.

**Independent Test**: Can be tested by producing an unknown message type (or simulating one) and verifying it renders in both views.

**Acceptance Scenarios**:

1. **Given** an agent session that produced an unknown/unsupported message type, **When** I view the session in the project chat, **Then** I see a fallback rendering of the message content rather than nothing.

---

### Edge Cases

- What happens when tool call content has no text and no structured data? Both views should show the tool call header (title, status) without content area.
- What happens when a tool call has a `toolCallId` not matching any previous tool call in the session? It should be created as a new tool call entry rather than silently dropped.
- What happens when plan entries have invalid JSON content in the persisted message? The plan should be skipped gracefully without breaking other messages.
- What happens when diff content exceeds the truncation limit? Both views should show the same truncated content with a truncation marker.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project chat's tool call content items MUST populate the `data` field for ALL content types (content, diff, terminal), not only for diffs. This ensures the JSON fallback rendering works when text is empty.
- **FR-002**: The project chat's tool call content items MUST populate the `text` field using the structured content from the persisted extraction pipeline consistently with how workspace chat processes it.
- **FR-003**: Plan entries MUST render using a single shared component used by both workspace chat and project chat, eliminating duplicated rendering code.
- **FR-004**: Project chat MUST render unknown/unsupported message types (raw fallback) as a visible fallback element rather than silently returning null.
- **FR-005**: All content types within tool calls (diff, terminal, content) MUST display equivalent information in both workspace and project views when given the same underlying data.

### Key Entities

- **ConversationItem**: Unified message type used for rendering. Variants: user_message, agent_message, thinking, tool_call, plan, system_message, raw_fallback.
- **ToolCallContentItem**: Structured content block within a tool call. Has type (content/diff/terminal), text, and data fields.
- **ChatMessageResponse**: Persisted message with role, content, and toolMetadata fields. Converted to ConversationItem for rendering.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Users viewing a completed agent session see identical message content (tool calls, plans, fallback messages) in both workspace and project views — no information is visible in one view but hidden in the other.
- **SC-002**: Zero duplicated message rendering code between workspace and project views for plan messages — both use the same shared component.
- **SC-003**: All tool call content types (diff, terminal, text) render with equivalent information in project chat compared to workspace chat, verified by automated tests.
- **SC-004**: Unknown message types produce a visible fallback rendering in project chat rather than being silently dropped, matching the workspace chat behavior.
