# Fix pre-existing chats, API-token and immersive-scroll Playwright audit failures

## Problem

These local Playwright audits fail on clean `origin/main` (b262cd4fb). They were reproduced in a
fresh worktree with `playwright.audit.config.ts` at iPhone SE (375x667) and Desktop (1280x800):

- `chats-audit.spec.ts`: all four scenarios ("Mobile › normal data", "empty state", "many items",
  "Desktop › normal data") on both projects time out. `waitForSelector('text=Fix authentication flow')`,
  `'text=No active chats'` and `'text=Session 1'` are never visible. The page or its mocks have
  likely drifted.
- `auth-flows-audit.spec.ts:77` › "settings API tokens workflow fits mobile and desktop" (both
  projects): `getByRole('heading', { name: 'Settings' })` is not found.
- `chat-immersive-audit.spec.ts:466` › "a reader scrolled up keeps their place through both
  toggles" (iPhone SE) is flaky, failing about 1 in 20 runs on `main` at `expect(before).not.toBeNull()`
  (line 481). `topRow()` is read right after `scrollBy(0, -600)` without waiting for the
  virtualized list to re-render rows under the new scroll position.

The composer-audit failures seen in the same run are already tracked in
`2026-11-07-fix-preexisting-chat-playwright-audit-failures.md`.

## Context

Found 2026-11-11 while auditing PR #2657 (React 19.3.1 / Storybook 10.6.6). The results were
identical on `main` and that branch, so these failures predate it.

## Acceptance Criteria

- [ ] Each `chats-audit` and `auth-flows-audit` failure is diagnosed: a real UI regression is
      fixed, or a stale spec is updated to the current intended UI with a reason
- [ ] The immersive-scroll test waits for a rendered top row (for example, polls `topRow()` until
      non-null) and passes 50/50 with `--repeat-each=50`
- [ ] Decide whether CI's `playwright-visual` job should run these specs at 375x667 and 1280x800
