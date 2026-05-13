# Fork/Retry: Navigate to New Chat Screen Instead of Popup Dialog

## Problem

The fork and retry buttons in the project chat session header currently open popup dialogs (`ForkDialog` and `RetryDialog`). The user wants these to instead navigate back to the "What do you want to build?" new chat screen, with the prompt pre-filled with the relevant content, and all session settings (agent type, workspace profile, task mode, etc.) available for modification.

The current popup approach is frustrating because:
- Can't change agent type (e.g., Claude Code to Codex)
- Can't change workspace profile (e.g., full to lightweight)
- Can't change task mode (e.g., task to conversation)
- Settings are locked in the popup — no flexibility when retrying or forking

## Research Findings

### Key Files
- `apps/web/src/components/project/ForkDialog.tsx` — Current fork popup (to be removed)
- `apps/web/src/components/project/RetryDialog.tsx` — Current retry popup (to be removed)
- `apps/web/src/pages/project-chat/index.tsx` — Main chat page, renders dialogs and ChatInput
- `apps/web/src/pages/project-chat/useProjectChatState.ts` — State management:
  - `handleNewChat()` navigates to new chat screen (no sessionId)
  - `submitDerivedTask()` handles fork/retry submission with `parentTaskId` + `contextSummary`
  - `handleFork()` / `handleRetry()` delegate to `submitDerivedTask()`
  - `showNewChatInput` is true when `!sessionId || sessions.length === 0`
- `apps/web/src/pages/project-chat/ChatInput.tsx` — Input area with all settings controls
- `apps/web/src/components/project-message-view/SessionHeader.tsx` — Has retry/fork buttons calling `onRetry`/`onFork`

### Current Flow
1. User clicks retry/fork button in SessionHeader
2. `onRetry`/`onFork` callback sets `retrySession`/`forkSession` state
3. `RetryDialog`/`ForkDialog` opens as a modal
4. Dialog loads context summary, pre-fills message
5. On submit, calls `submitDerivedTask()` which calls `submitTask()` API with `parentTaskId` + `contextSummary`

### New Flow
1. User clicks retry/fork button in SessionHeader
2. Navigate to new chat screen (`/projects/:id/chat`) — same as "New Chat"
3. Pre-fill the message textarea with the fork/retry content
4. Show a context banner above the settings indicating fork/retry lineage
5. User can modify ALL settings (agent, workspace profile, task mode, etc.)
6. On submit, call `submitDerivedTask()` with `parentTaskId` + `contextSummary`

### Implementation Approach
- Add `pendingDerived` state to `useProjectChatState` holding `{ type: 'fork' | 'retry', session, parentTaskId, contextSummary }`
- When fork/retry is clicked, populate `pendingDerived` and navigate to new chat screen
- When `pendingDerived` is set and `showNewChatInput` is true, show a context banner
- Modify `handleSubmit` to include `parentTaskId` and `contextSummary` from `pendingDerived` when present
- Remove `ForkDialog` and `RetryDialog` components (dead code after this change)

## Implementation Checklist

- [x] Add `pendingDerived` state type and state to `useProjectChatState.ts`
- [x] Modify fork/retry handlers to populate `pendingDerived`, pre-fill message, and navigate to new chat screen
- [x] Load context summary in background when `pendingDerived` is set (for fork, auto-generate summary; for retry, fetch original task description)
- [x] Modify `handleSubmit` to include `parentTaskId` and `contextSummary` from `pendingDerived`
- [x] Create `DerivedSessionBanner` component to show fork/retry lineage context above the ChatInput settings
- [x] Render `DerivedSessionBanner` in `index.tsx` when `pendingDerived` is set and `showNewChatInput` is true
- [x] Remove `ForkDialog` and `RetryDialog` imports and usage from `index.tsx`
- [x] Delete `ForkDialog.tsx` and `RetryDialog.tsx` files
- [x] Run Playwright visual audit with mock data on mobile and desktop viewports
- [x] Add/update tests for the new flow

## Acceptance Criteria

- [x] Clicking retry in session header navigates to new chat screen with message pre-filled
- [x] Clicking fork in session header navigates to new chat screen with fork template pre-filled
- [x] A banner above the settings indicates whether this is a fork or retry, with parent session info
- [x] All chat settings (agent type, workspace profile, task mode, devcontainer config) are modifiable
- [x] Submitting sends the task with `parentTaskId` and `contextSummary` (same API contract as before)
- [x] Clicking "New Chat" while a derived session is pending clears the pending state
- [x] ForkDialog and RetryDialog are removed from the codebase
- [x] No regressions in normal new chat flow
