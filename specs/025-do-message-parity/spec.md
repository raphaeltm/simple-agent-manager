# Feature Specification: DO Message Parity with Agent Stream

**Feature Branch**: `025-do-message-parity`
**Created**: 2026-03-08
**Status**: Draft
**Input**: User description: "Address disparities in information provided from DO messages vs direct agent messages. Tool calls, thinking blocks, plans, and diff content are not visible in project chat like they are in workspace chat."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Tool Call Fidelity in Project Chat (Priority: P1)

As a user viewing a task's chat history in project chat, I want to see tool calls displayed with the same fidelity as workspace chat — a single card per tool call showing its title, kind, status, structured content (including diffs and terminal output), and file locations — so that I can understand what the agent did without needing to connect to the workspace directly.

**Why this priority**: Tool calls are the most frequent and information-rich agent interaction. Without them, project chat is essentially a text-only view that hides 80%+ of the agent's work. This is the highest-impact improvement.

**Independent Test**: Can be tested by running a task that uses tools (e.g., file edit, bash command), then viewing the session in project chat. Tool cards should display with title, kind, status, diff content, and terminal output matching what workspace chat shows.

**Acceptance Scenarios**:

1. **Given** an agent session that performed file edits, **When** I view the session in project chat, **Then** I see a single tool card per tool call (not duplicates from updates) with the correct final status, diff content showing the actual changes, and file locations
2. **Given** an agent session that ran bash commands, **When** I view the session in project chat, **Then** I see tool cards with the terminal ID reference (terminal output content is streamed via separate ACP terminal protocol and is not available in the tool call notification itself)
3. **Given** an active agent session with a tool call in progress, **When** I view the session in project chat, **Then** the tool card shows the current status (pending/in_progress) and updates to completed when done, without creating duplicate cards

---

### User Story 2 - Thinking Block Persistence (Priority: P2)

As a user reviewing a completed task's chat history, I want to see the agent's thinking/reasoning blocks so that I can understand the agent's decision-making process without having been connected to the workspace chat during execution.

**Why this priority**: Thinking blocks provide crucial context for understanding agent decisions. They're especially valuable for debugging agent behavior and for users who review task results asynchronously.

**Independent Test**: Can be tested by running a task where the agent produces thinking blocks (extended thinking), then viewing the session in project chat after the session ends. Thinking blocks should appear as collapsible sections.

**Acceptance Scenarios**:

1. **Given** an agent session that produced thinking blocks, **When** I view the session in project chat after it completes, **Then** I see thinking blocks rendered as collapsible sections
2. **Given** an agent session in progress with thinking content, **When** I view via project chat live, **Then** thinking blocks appear inline with other messages

---

### User Story 3 - Plan Persistence (Priority: P3)

As a user reviewing a task's chat history, I want to see any plans the agent created during execution so that I can understand the agent's approach to the task.

**Why this priority**: Plans provide high-level structure of the agent's approach. Useful but less critical than tool calls and thinking since plans are typically less frequent and summarized in the agent's text responses.

**Independent Test**: Can be tested by running a task where the agent creates a plan, then viewing the session in project chat. Plan items should appear with their entries and status.

**Acceptance Scenarios**:

1. **Given** an agent session that produced plan items, **When** I view the session in project chat, **Then** I see plan entries with their titles and completion status

---

### Edge Cases

- What happens when `toolMetadata` JSON is malformed? → Fall back to displaying raw content text
- What happens when a tool call has no updates (only the initial `tool_call`)? → Display as a single card with the status from the initial call
- What happens when multiple tool call updates arrive for the same `toolCallId` but the initial `tool_call` is missing from DO? → Display the update as a standalone card
- What happens with very large diff content (e.g., 10MB file edit)? → Truncate content at a configurable max size before persistence
- What happens with thinking blocks that are very long? → Render collapsed by default with expand capability (same as workspace chat)

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: VM agent `ExtractMessages()` MUST extract `agent_thought_chunk` notifications as messages with `role = "thinking"`
- **FR-002**: VM agent `ExtractMessages()` MUST extract `plan` notifications as messages with `role = "plan"`
- **FR-003**: VM agent `ExtractMessages()` MUST preserve the ACP `toolCallId` in `ToolMeta` for tool call and tool call update messages
- **FR-004**: VM agent `extractStructuredContent()` MUST include actual diff content (`OldText`, `NewText`, `Path` from `ToolCallContentDiff`) in `ToolContentItem` (not just file paths)
- **FR-005**: VM agent `extractStructuredContent()` MUST preserve terminal ID references in `ToolContentItem` (note: actual terminal output is streamed via separate ACP terminal protocol and is not embedded in tool call notifications; the `ToolCallContentTerminal` struct only carries `TerminalId`)
- **FR-006**: DO `chat_messages` schema MUST support `role = "thinking"` and `role = "plan"` message types
- **FR-007**: `chatMessagesToConversationItems()` MUST convert `role = "thinking"` messages to `ThinkingItem` conversation items
- **FR-008**: `chatMessagesToConversationItems()` MUST convert `role = "plan"` messages to `PlanItem` conversation items
- **FR-009**: `chatMessagesToConversationItems()` MUST deduplicate tool calls by `toolCallId` (from `toolMetadata`), merging updates into a single `ToolCallItem`
- **FR-010**: Content size for diff and terminal output MUST be capped at a configurable maximum (env var `MAX_TOOL_CONTENT_SIZE`, default 100KB) to prevent excessive storage
- **FR-011**: System MUST NOT regress workspace chat behavior — the direct ACP WebSocket path must remain unchanged

### Key Entities

- **ExtractedMessage**: Enhanced with `thinking` and `plan` role types, and `toolCallId` field in ToolMeta
- **ToolMeta**: Enhanced with `toolCallId` field and richer content items (actual diff text, terminal output)
- **ToolContentItem**: Enhanced to carry actual diff content (old_text, new_text, path) instead of just file paths; terminal IDs preserved as-is
- **ChatMessage (DO)**: Extended `role` enum to include `thinking` and `plan`

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Project chat displays tool calls with the same information density as workspace chat (title, kind, status, diff content, locations)
- **SC-002**: No duplicate tool call cards appear in project chat for tool calls that received status updates
- **SC-003**: Thinking blocks are visible in project chat history after a session completes
- **SC-004**: Plan items are visible in project chat history after a session completes
- **SC-005**: All existing workspace chat tests continue to pass without modification
