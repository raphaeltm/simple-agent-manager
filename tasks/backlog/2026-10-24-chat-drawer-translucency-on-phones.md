# The chat's full-screen drawers are translucent on a phone, with nothing dimmed behind them

## Problem

Every on-demand panel the chat tool rail opens — Timeline, Comments, Resources, Automation and
now Related — renders `glass-modal` (55% opaque in dark mode, 60% in light) and hides its dim
backdrop below the `md` breakpoint (`hidden md:block` on the scrim). On a phone the panel is
full screen, so the backdrop looks unnecessary, but the panel itself is see-through: the tool
rail's icons, the composer's "Send a message..." placeholder and the conversation behind it all
ghost through the content.

`backdrop-filter: blur(...)` softens it in a real browser, so this reads as a stylistic quirk
rather than a defect at a glance. It is still a legibility cost that lands on exactly the
viewport SAM is used from most, and it is the reason headless screenshots of those panels look
muddy.

## Context

Found while reviewing the T4 "Related work" panel
(`tasks/archive/2026-10-24-linked-work-show-links-chats-files.md`, PR for branch
`sam/t4-show-links-chats-qeryzv`). The ui-ux-specialist confirmed it is byte-for-byte the same
pattern as every sibling drawer and therefore **not** a T4 regression — which is why it is filed
here rather than fixed there. It now affects five surfaces, so it is worth one change in one
place rather than five.

Affected files, all with the same two lines:

- `apps/web/src/components/chat/SessionLinkedWorkDrawer.tsx`
- `apps/web/src/components/chat/SessionAutomationDrawer.tsx`
- `apps/web/src/components/chat/SessionCommentsDrawer.tsx`
- `apps/web/src/components/chat/SessionResourceHistoryDrawer.tsx`
- `apps/web/src/components/chat/ChatTimelineDrawer.tsx`

## Acceptance criteria

- [ ] A full-screen drawer on a phone is legible without the conversation, the composer or the
      tool rail showing through it. Either show the dim backdrop at every width, or give the
      panel an opaque background when it is full screen — decide which, and say why in the code.
- [ ] Whatever is chosen applies to all five drawers, from one place, not five copies
      (`.claude/rules/24-no-duplicate-ui-controls.md`).
- [ ] The desktop rail form is unchanged: there the panel genuinely floats over the conversation
      and the glass treatment is the intent.
- [ ] Playwright screenshots at 375x667 for each of the five panels, before and after, reviewed
      and posted (`apps/web/.claude/rules/17-ui-visual-testing.md`). Headless Chromium does not
      apply `backdrop-filter`, so also check one panel in a real browser on staging before
      concluding the blur was the fix.
- [ ] Light mode checked too: `--sam-glass-bg-modal` is 60% there, so the bleed-through is at
      least as visible.
