# Split `useSessionLifecycle` below the file-size ceiling

## Problem

`apps/web/src/components/project-message-view/useSessionLifecycle.ts` is 740 lines, over the 500-line split threshold in `.claude/rules/18-file-size-limits.md`. It owns several independent concerns in one hook: the session query and cache seeding, the WebSocket wiring and reconnect catch-up, the degraded fallback poll, wake/sleep state, prompt send and cancel, file uploads, plan hydration, and older-history paging.

## Context

The transcript-boundary fix (branch `sam/fix-silent-transcript-loss-rtg8mb`) moved the paging it touched into `apps/web/src/lib/message-paging.ts` (`refreshCachedTranscript`, `fetchHistoryUntil`), taking the hook from 768 to 740 lines. A full split was out of scope for that fix: every concern above shares hook state, and moving them is a refactor that deserves its own review and rendered tests.

## Acceptance Criteria

- [ ] The hook is split into focused hooks or modules named for what each decides (for example the fallback poll, reconnect catch-up, and history paging), each under 500 lines.
- [ ] Existing `useSessionLifecycle` and `ProjectMessageView` tests pass unchanged, or are moved alongside the code they cover without weakening an assertion.
- [ ] No behavior change: the Playwright chat audits produce the same screenshots before and after.
