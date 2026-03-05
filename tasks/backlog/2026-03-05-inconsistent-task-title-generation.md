# Inconsistent Task Title Generation

## Problem

Task title generation via Workers AI is inconsistent. Of 4 tasks submitted in rapid succession during testing:
- 1 task got a clean AI-generated title: "Create Upgrade Plan for Project Dependencies"
- 1 task got a markdown-garbled AI-generated title (see separate bug)
- 2 tasks showed the raw message text truncated as the title (no AI generation at all)

The tasks that fell back to raw message text:
- "Perform a comprehensive security audit of this repository. Check for: 1) Dependency vulnerabiliti..."
- "Add a CONTRIBUTING.md file to the repository that documents the development workflow, coding stan..."

## Context

- **Discovered**: 2026-03-05 during manual QA testing
- **Severity**: Low — functional but inconsistent UX
- **Possible cause**: Rate limiting on Workers AI, timeout during concurrent title generation (4 tasks submitted within ~60 seconds), or the title generation running as fire-and-forget with a race condition

## Investigation Areas

- Check if `TASK_TITLE_TIMEOUT_MS` is too aggressive for concurrent requests
- Check if Workers AI has per-minute rate limits that would cause failures under burst load
- Check error handling: does title generation failure silently fall back to truncation without logging?
- Check `TASK_TITLE_SHORT_MESSAGE_THRESHOLD` — the failed messages are well above 100 chars, so this shouldn't apply

## Acceptance Criteria

- [ ] All tasks get AI-generated titles (or explicit fallback with warning log)
- [ ] Title generation handles concurrent requests gracefully (queue or retry)
- [ ] Failed title generation attempts are logged with reason (timeout, rate limit, error)
- [ ] Test: Submit 5 tasks in rapid succession and verify all get generated titles
