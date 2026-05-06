# Compact Mode Test Coverage Gaps

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
