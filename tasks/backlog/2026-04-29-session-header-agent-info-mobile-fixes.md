# Session Header Agent Info — Post-Merge Fixes

## Problem

Post-merge reviews of PR #856 identified issues in the agent info row added to SessionHeader's expanded panel:

1. **Long profile hint overflow (HIGH)**: The `agentProfileHint` span has no `truncate`, `max-w`, or `min-w-0` constraint. Single-token slugs like `custom-profile-with-very-long-name-that-might-overflow` won't wrap (no spaces to break on) and can push the parent to overflow on 375px viewports. The `flex-wrap` on the parent row doesn't help for unbreakable tokens.

2. **Missing aria-hidden on icons (LOW)**: The four new icons (`Bot`, `MessageSquare`, `Cpu`, `User2`) lack `aria-hidden="true"`, which the established `ContextItem` and `CopyableId` patterns include.

3. **Missing backend unit tests (HIGH)**: The chat session detail route returns three new fields (`agentType`, `taskMode`, `agentProfileHint`) but no backend test asserts they appear in the response. The existing test at `apps/api/tests/unit/routes/chat-session-agent-routing.test.ts` doesn't cover them.

4. **Shared type gap (MEDIUM)**: `agentType` was added to the web-only `ChatSessionResponse` type but not to the shared `ChatSession`/`ChatSessionDetail` interfaces in `packages/shared/src/types/session.ts`.

## Files

- `apps/web/src/components/project-message-view/SessionHeader.tsx` — lines ~337-355
- `apps/api/tests/unit/routes/chat-session-agent-routing.test.ts` — backend test
- `packages/shared/src/types/session.ts` — shared types
- `apps/api/src/routes/chat.ts` — route returning the new fields

## Implementation Checklist

### UI Fixes
- [ ] Add `truncate min-w-0 max-w-[16rem]` to the profile hint span and wrap the text in a `<span className="truncate">`
- [ ] Add `shrink-0` to the `User2` icon so it doesn't compress when text truncates
- [ ] Add `aria-hidden="true"` to all four icons in the agent info row (`Bot`, `MessageSquare`, `Cpu`, `User2`)
- [ ] Run Playwright visual audit on mobile (375px) with a long single-token profile hint to confirm truncation works
- [ ] Verify no horizontal overflow on mobile

### Backend & Type Fixes
- [ ] Add `agentType?: string | null` to `ChatSession` interface in `packages/shared/src/types/session.ts`
- [ ] Add backend test assertions to `chat-session-agent-routing.test.ts`:
  - `body.session.agentType` equals ACP session's `agentType` when present
  - `body.session.task.taskMode` and `body.session.task.agentProfileHint` present when task row has them
  - `body.session.agentType` is null when ACP session omits it

## Acceptance Criteria

- [ ] A 72-character single-token profile hint truncates with ellipsis on mobile viewport
- [ ] All icons in the agent info row have `aria-hidden="true"`
- [ ] No horizontal overflow on 375px viewport with any combination of agent info values
- [ ] Backend tests assert `agentType`, `taskMode`, `agentProfileHint` in route response
- [ ] Shared `ChatSession` type includes `agentType`

## Context

- Source: UI/UX specialist + task completion validator reviews of PR #856 (late-arriving, post-merge)
- Severity: HIGH (F1, F3), MEDIUM (F4), LOW (F2)
