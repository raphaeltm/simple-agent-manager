# Automation page follow-ups (deferred review findings)

## Problem

The specialist review of the Automation page (branch `sam/automation-page`, task
`tasks/archive/2026-10-20-automation-page.md`) raised three low-risk findings that need API or
repo-wide changes, which that UI-only PR deliberately avoided. Each degrades safely today.

## Context

1. **Watch pause reasons are matched by text.** `apps/web/src/pages/automation/model.ts`
   (`WATCH_TARGET_NOT_OWNED`, `WATCH_CREATOR_ACCESS_REVOKED`) copies the runner's reasons:
   `STANDING_WATCH_TARGET_NOT_OWNED` in
   `apps/api/src/durable-objects/project-data/project-standing-watches-authority.ts` and the
   inline `'Creator project access was revoked'` in `project-standing-watches-runner.ts`. If the
   API rewords either, the page falls back to "Paused: <reason>" and loses the "Paused by SAM"
   framing. (Task-completion validator, LOW.)
2. **Chat list page cap mirrored by a literal.** `CHAT_SESSION_LIST_API_MAX = 100` in
   `apps/web/src/lib/automation-config.ts` mirrors the bare `100` in
   `apps/api/src/routes/chat-session-list.ts`; neither is a named shared constant.
   (Constitution validator, LOW.)
3. **Positive-integer env parsing is copied per module.** `positiveInt` in
   `apps/web/src/lib/automation-config.ts`, `resolveIntervalMs`/`resolvePositiveInteger` in
   `lib/poll-intervals.ts`, `positiveIntFromEnv` in `lib/lazy-with-retry.ts`, `envInt` in
   `lib/query-options/credential-limits.ts`, `readPositiveIntEnv` in `lib/query-persist-config.ts`.
   (Architecture reviewer, MEDIUM; repo-wide pattern that predates the Automation page.)

## Acceptance Criteria

- [ ] Watch pause reasons live in `@simple-agent-manager/shared` (a stable code would be better
      than text); the API runner and authority use them, the web reads them, and a test pins it.
- [ ] The chat-session list cap is a named shared constant used by the API route and by
      `automation-config.ts`.
- [ ] One exported positive-integer env parser in `apps/web/src/lib/`, used by every config
      module above, with a unit test.
