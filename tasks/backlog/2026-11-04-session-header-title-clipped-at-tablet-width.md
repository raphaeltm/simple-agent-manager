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

## Acceptance Criteria

- [ ] The session header title wraps or truncates inside its slab at 768px, with no
      horizontally clipped content (`assertNoClippedOverflow` passes on the chat page at
      `Tablet (768x1024)`)
- [ ] Consider whether 768px should use the phone layout or collapse the chat list so the
      conversation column is not ~180px wide
- [ ] Re-enable the tablet clipped-overflow assertion in `chat-immersive-audit.spec.ts`
