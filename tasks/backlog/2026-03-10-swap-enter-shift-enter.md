# Swap Enter / Shift+Enter in Chat Inputs

## Problem

Currently, Enter sends a message and Shift+Enter creates a new line. On mobile, Shift+Enter is hard to type. Swapping the behavior (Enter = newline, Shift+Enter = send) is more mobile-friendly.

## Affected Files

- `apps/web/src/pages/ProjectChat.tsx` (lines 759-763, hint at 790)
- `apps/web/src/components/chat/ProjectMessageView.tsx` (lines 1000-1004)
- `apps/web/src/components/task/TaskSubmitForm.tsx` (lines 102-105) — single-line input, keep Enter=submit here since it's a title field

## Checklist

- [ ] Swap keyboard behavior in `ProjectChat.tsx`: Shift+Enter sends, Enter is default (newline)
- [ ] Update hint text in `ProjectChat.tsx` from "Press Enter to send, Shift+Enter for new line" to "Press Shift+Enter to send, Enter for new line"
- [ ] Swap keyboard behavior in `ProjectMessageView.tsx`
- [ ] Keep `TaskSubmitForm.tsx` as-is (single-line title input, Enter to submit is standard)
- [ ] Run typecheck and lint
- [ ] Run tests

## Acceptance Criteria

- Enter key inserts a newline in chat textareas
- Shift+Enter submits the message in chat textareas
- Hint text reflects the new behavior
- TaskSubmitForm (single-line input) unchanged
