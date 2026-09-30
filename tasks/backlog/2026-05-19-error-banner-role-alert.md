# Add role="alert" to error banner in project chat

> **Reconciliation 2026-09-30:** still open, retargeted. #1765 (`8eed3b740`) replaced
> `ErrorBanner` with `FailureCard` (`apps/web/src/components/debug/FailureCard.tsx`, rendered at
> `apps/web/src/components/project-message-view/FloatingHeader.tsx:107`). Neither the card root
> (`FailureCard.tsx:127-134`) nor its wrapper has `role="alert"` or `aria-live`, so the failure is
> still not announced to screen readers. Apply the fix and the test there.

## Problem

The glass-chrome error banner in `ProjectMessageView` (showing "Task failed: ...") does not have `role="alert"`, so screen readers won't automatically announce it when it renders. The existing resume-error banner at line ~164 of `index.tsx` correctly uses `role="alert"`, but the task-failure `ErrorBanner` component does not.

## Context

Discovered during UI/UX specialist review of PR #1056 (error banner glass-chrome styling). Filed as a follow-up since the PR was already merged.

## Implementation Checklist

- [ ] Add `role="alert"` to the `ErrorBanner` component in `apps/web/src/components/project-message-view/index.tsx`
- [ ] Add a unit test asserting the error banner has `role="alert"`

## Acceptance Criteria

- [ ] Error banner div has `role="alert"` attribute
- [ ] Screen readers announce the error message when it appears
- [ ] Unit test verifies the attribute is present
