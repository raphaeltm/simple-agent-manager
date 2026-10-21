# Docs: expired-chat screenshots and wording drifted from the archived fork composer

## Problem

`apps/web/tests/playwright/docs-screenshots-chat-states.spec.ts` › `openExpiredChat` expects a **Fork conversation** button on the expired chat. On `main` (c0fb8edd8) its fixture session has `status: 'stopped'`, so `SessionFooter.tsx` renders `ArchivedForkComposer` instead: a "Write a prompt to fork this archived chat..." box with a **Fork** button. **Fork conversation** now only appears for an expired chat whose session is not `stopped`.

Consequences:

- "docs: expired chat" and "docs: expired chat on a phone" fail, so `chat-expired.png` and `chat-expired-mobile.png` cannot be regenerated.
- The docs still describe only **Fork conversation** for expired chats:
  - `guides/chat-features.md` (Conversation Forking, step 2)
  - `guides/session-troubleshooting.md`
  - `guides/instant-sessions.md`
  - `guides/recent-product-changes.md`

## Context

Found on 2026-10-21 while regenerating `chat-fork-composer*.png` for the new-chat profile picker (branch `sam/new-chat-profile-picker`). That branch moved the fork-composer capture to the session tool rail's Fork, which works on `main`. It left the expired-chat captures and wording alone.

## Acceptance criteria

- [ ] Decide which expired-chat footer each session state should show, and confirm `SessionFooter.tsx` matches.
- [ ] Update `openExpiredChat` to assert the footer the fixture actually gets, and regenerate `chat-expired*.png`.
- [ ] Update the four guides so they describe the archived fork composer and, where it still applies, **Fork conversation**.
