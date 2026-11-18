# The chat session header clips its title at tablet width (768px)

## Problem

At 768x1024 the desktop chat layout leaves the conversation column about 180px wide, and the
session header slab (`FloatingHeader` / `SessionHeader`) clips its title horizontally:
`assertNoClippedOverflow` reports "content 129px clipped to 126px — Competitor UI research: T3
Code & multi-" on the slab `div.sam-glass.sam-glass--slab`.

## Context

Found 2026-11-04 while building `apps/web/tests/playwright/chat-immersive-audit.spec.ts`.
Reproduced on unmodified `main` code (same 3px clip) with `setupGlassChatMocks` on the
`Tablet (768x1024)` project, so it predates that change. Not the session-list title bug in
`2026-11-04-session-title-zero-width-beside-long-connector-chip.md`.

Also at 768px: `acp-permission-chat-audit.spec.ts`'s "Mobile" cases fail `assertNoClippedOverflow`
locally on the `Tablet (768x1024)` project (the same header clip, plus a tool-activity card clipped
from 127px to 73px in the ~180px conversation column). CI runs that spec on iPhone 14 only, so it
does not see them.

## Acceptance Criteria

- [ ] The session header title wraps or truncates inside its slab at 768px, with no
      horizontally clipped content (`assertNoClippedOverflow` passes on the chat page at
      `Tablet (768x1024)`)
- [ ] Consider whether 768px should use the phone layout or collapse the chat list so the
      conversation column is not ~180px wide
- [ ] Re-enable the tablet clipped-overflow assertion in `chat-immersive-audit.spec.ts`
- [ ] `acp-permission-chat-audit.spec.ts` passes on `Tablet (768x1024)`
- [ ] At 768px the tool rail's scroller (`session-tool-rail-scroller`) covers the composer's Send
      button, so `session-header-agent-info-audit.spec.ts` "sleeping VM session stays visible and
      the composer queues its wake" times out on `Tablet (768x1024)`. Reproduced on unmodified
      `main` at 1df45ee7e (found 2026-11-05 while shipping the one-row phone header).
