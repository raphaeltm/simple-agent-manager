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

## Related: copy-feedback timers that outlive their component

PR #2657 fixed `CopyableId` (`apps/web/src/components/project-message-view/CopyableId.tsx`). Its
1.5s "copied" reset timer was never cleared on unmount, and on CI it fired after jsdom teardown
(`ReferenceError: window is not defined`), failing the web Test job. The same uncleared
`setTimeout(() => setX(false), N)` pattern remains in `ApiTokens.tsx:97`, `admin/LogStream.tsx:75`,
`admin/CopyableIdPill.tsx:23`, `admin/ObservabilityLogEntry.tsx:128`, `shared/log/CopyButton.tsx:30`,
`pages/ToolsCli.tsx:78`, `pages/sam-prototype/sam-markdown.tsx:42` and
`pages/SettingsComputeUsage.tsx:344`.

- [ ] Clear each timer on unmount (timer ref + cleanup effect, as in `CopyableId` and
      `packages/acp-client/src/components/MessageActions.tsx`), or extract one shared hook
- [ ] Add an unmount test per component that asserts no timer remains pending (`vi.getTimerCount()`)
