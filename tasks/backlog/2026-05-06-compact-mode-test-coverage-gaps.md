# Compact Mode Test Coverage Gaps

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - The `chatMessagesToConversationItems` compact path is covered in
>     `apps/web/tests/unit/components/chatMessagesToConversationItems.test.ts:260-270` and
>     :392-411 (metadata `contentSize` with no content array gives `contentLoaded: false`, a
>     `messageId` and `content: []`).
>   - A basic `ToolCallCard` lazy-load test: a click calls `onLoadContent` and the result renders
>     (`packages/acp-client/tests/unit/components/ToolCallCard.test.tsx:143-160`).
> - **Still open:**
>   - `ToolCallCard`: assert the loading state while the load is pending, assert non-empty loaded
>     content, and assert that a second click does not call `onLoadContent` again (cache hit).
>   - The `contentSize === 0` edge case.
>   - Summarize route: assert that `getMessages` is called with compact off. The route now lives
>     in `apps/api/src/routes/chat-fork.ts:94` (it passes `false` at :109-118); the test at
>     `apps/api/tests/unit/routes/chat-fork.test.ts:170-180` does not check it.

## Problem

Post-merge task-completion-validator identified test coverage gaps in the compact mode feature (PR #919). The core functionality works correctly (18 unit tests, staging verified), but three areas lack behavioral tests.

## Context

Discovered by task-completion-validator running against PR #919 (`sam/compact-mode-lazy-load-tool-content`). The validator ran against an earlier branch state for some findings — `getMessageToolContent` tests were added in commit `387c1645` before merge.

## Checklist

- [ ] Add behavioral tests for `ToolCallCard` lazy-load in `packages/acp-client/tests/unit/components/ToolCallCard.test.tsx`:
  - Render with `contentLoaded: false`, `messageId: 'msg-1'`, mock `onLoadContent`
  - Simulate click, assert loading state appears
  - Await resolution, assert loaded content renders
  - Simulate second click, assert `onLoadContent` not called again (cache hit)
- [ ] Add tests for `chatMessagesToConversationItems` compact-mode path in `apps/web/tests/unit/components/chatMessagesToConversationItems.test.ts`:
  - Pass tool-role message with `toolMetadata: { contentSize: 500 }` (no content array)
  - Assert resulting `ToolCallItem` has `contentLoaded: false`, `messageId` set, `content: []`
  - Verify `contentSize === 0` edge case
- [ ] Add assertion for summarize route `compact=false` in chat route tests:
  - Assert `projectDataService.getMessages` called with `compact: false` when summarize endpoint invoked

## Acceptance Criteria

- [ ] All three test areas have passing behavioral tests
- [ ] No regressions in existing 18 compact mode tests
