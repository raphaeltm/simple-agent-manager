# Stale notification-center tests in settings-notifications-audit.spec.ts

## Problem

Four Playwright tests in `apps/web/tests/playwright/settings-notifications-audit.spec.ts` click a
"need attention" button from the old notification bell panel, which the Inbox replaced (inbox
slice C). They time out on every viewport:

- "structured answers remain keyboard-safe and contained with a long mobile option" (line 265)
- "structured answer panel fits the desktop viewport" (line 359)

## Context

Found 2026-11-18 while capturing screenshot evidence for PR #2881. The tests are unrelated to that
PR; `grep "need attention" apps/web/src` finds no such button.

## Acceptance Criteria

- [ ] The stale tests are removed, or rewritten against the Inbox (answering a structured question
      from the inbox item or quick view) with a long option and no overflow at 375px and 1280px
- [ ] `settings-notifications-audit.spec.ts` passes on both viewports
