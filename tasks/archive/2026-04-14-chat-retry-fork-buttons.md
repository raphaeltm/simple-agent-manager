# Chat Retry & Fork Buttons

## Problem

Users need the ability to **retry** (re-run the same task) and **fork** (start a new task with context from a previous one) directly from the project chat session view. Currently:

- **Fork** exists only in the session sidebar list (SessionItem) — users must find the session in the sidebar, and it only appears for terminated sessions with a task ID. There's no fork button in the active session view itself.
- **Retry** doesn't exist at all — if a task fails, the user has to manually copy the original message and submit a new task.

Both actions should be available at all times (active, idle, terminated) so users can always retry or fork.

## Research Findings

### Existing Infrastructure
1. **ForkDialog** (`apps/web/src/components/project/ForkDialog.tsx`) — Already handles fork flow: generates AI summary of parent session, lets user write new instructions, submits via `onFork(message, contextSummary, parentTaskId)`.
2. **`handleFork`** in `useProjectChatState.ts` (line 400) — Submits fork via `submitTask()` with `parentTaskId` + `contextSummary`.
3. **`SubmitTaskRequest`** in shared types already has `parentTaskId` and `contextSummary` fields.
4. **SessionHeader** (`SessionHeader.tsx`) — The expanded details panel has action buttons (Files, Git, Browser, Workspace, Complete). This is where retry/fork should go.
5. **First user message** — Available via `lc.messages` in the session lifecycle. The first message with `role === 'user'` is the original task prompt.
6. **Task description** — Also available via `lc.taskEmbed` embedded in the session, though the full description may need fetching via `getProjectTask()`.

### UX Research
- **Retry pattern**: ChatGPT/Claude use a circular arrow icon, placed on the last assistant message. For SAM, retry means "re-submit the same task as a new session" — a session-level action, best placed in the session header.
- **Fork pattern**: Most products use edit-and-resubmit or "new chat with context". SAM already has `ForkDialog` which is the right approach — show context summary + editable new message.
- **Confirmation**: The edit/preview step serves as confirmation. No modal "Are you sure?" needed — the dialog IS the confirmation.
- **Icons**: `RotateCcw` for retry (universal "do again"), `GitFork` for fork (developer audience understands branching).
- **Pre-filled content**: For retry, show the original message in a confirmation dialog. For fork, the existing ForkDialog pattern is correct — pre-fill with AI summary + editable message area.

### Retry Design
The user wants retry to:
1. Show a dialog with the original message
2. Include the existing task/session ID as context (indicate this is a retry of a failed/previous task)
3. On confirm, submit a new task with the same message + a system message noting the retry context

### Fork Design
The user wants fork to:
1. Pre-fill a message template that instructs the agent to use SAM MCP tools to fetch context from the previous session
2. Let the user add their own instructions below the template
3. Submit as a new task with `parentTaskId` + `contextSummary`

### Key Design Decision: Always Available
Both buttons must be available regardless of session state (active, idle, terminated). The current fork button in SessionItem only shows for `terminated` sessions — the new buttons in SessionHeader should always show.

## Implementation Checklist

### 1. Add RetryDialog component
- [x] Create `apps/web/src/components/project/RetryDialog.tsx`
- [x] Show original task message (first user message) in a read-only preview
- [x] Show parent session ID/topic for context
- [x] Editable message field pre-filled with original message (fetched via getProjectTask API)
- [x] Option text noting "Retrying session [topic]"
- [x] Submit creates a new task with the message + contextSummary noting this is a retry of session X

### 2. Update ForkDialog for new fork template
- [x] Pre-fill the "What should the agent do next?" field with MCP tools reference template
- [x] Ensure the template is editable and the user can modify/replace it

### 3. Add Retry and Fork buttons to SessionHeader
- [x] Add `RotateCcw` (retry) and `GitFork` (fork) buttons to the action buttons row in SessionHeader
- [x] Both buttons always visible (not gated on session state or expanded panel)
- [x] Place them in the compact header row (always visible, not in expanded panel)
- [x] Wire up to open RetryDialog and ForkDialog respectively

### 4. Wire up state and handlers
- [x] Add `retrySession` state to `useProjectChatState` (similar to `forkSession`)
- [x] Add `handleRetry` handler (separate from `handleFork`, both delegate to `submitDerivedTask`)
- [x] Pass retry/fork callbacks down through ProjectMessageView → SessionHeader
- [x] Ensure the first user message is available for the retry dialog (via getProjectTask API)

### 5. Update ForkDialog to work without requiring terminated state
- [x] Header buttons bypass `canFork = state === 'terminated'` restriction (sidebar behavior unchanged)
- [x] ForkDialog works for any session that has a task ID

### 6. Tests
- [x] Unit test RetryDialog renders with original message
- [x] Unit test RetryDialog submit calls handler with correct params
- [x] Unit test SessionHeader shows retry/fork buttons in all states (active, idle, terminated)
- [x] Unit test SessionHeader hides buttons when session has no task
- [x] Sidebar fork regression test (SessionItem still shows fork button, click calls handler)

## Acceptance Criteria

- [x] Retry button (RotateCcw icon) visible in session header for all sessions with a task
- [x] Fork button (GitFork icon) visible in session header for all sessions with a task
- [x] Retry dialog shows original message, session reference, and submits a new task
- [x] Fork dialog pre-fills with MCP tool reference template
- [x] Both buttons work for active, idle, and terminated sessions
- [x] No regressions to existing fork functionality in sidebar
- [ ] Mobile-friendly layout (buttons don't overflow on small screens)

## References

- `apps/web/src/components/project/ForkDialog.tsx` — existing fork dialog
- `apps/web/src/components/project-message-view/SessionHeader.tsx` — session header
- `apps/web/src/pages/project-chat/useProjectChatState.ts` — chat state management
- `apps/web/src/pages/project-chat/SessionItem.tsx` — existing sidebar fork button
- `packages/shared/src/types/task.ts` — SubmitTaskRequest with parentTaskId/contextSummary
