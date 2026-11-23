# Compact inbox header

## Problem

Raphaël (2026-11-20, screenshot of the project inbox): the inbox header takes too much
screen. It spends a line on "What your agents need from you in <project>." and a second row
on the filter chips and ⋯ menu. General rule he stated: always ask "is there more text than
necessary on the screen, and are elements that are not central to what the user wants to
do here taking too much space?"

## Research

- Header: `apps/web/src/pages/inbox/InboxPage.tsx` (`InboxPage`, header `Pane`). Desktop shows
  title + subtitle, then `InboxFilterBar` on its own row. Mobile already hides title and
  subtitle and shows only the chip row.
- Chips + ⋯: `apps/web/src/components/inbox/InboxFilterBar.tsx` (unchanged; it already scrolls
  horizontally and keeps ⋯ pinned right).
- No existing "?" help popover in the app. The ⋯ menu's local disclosure pattern
  (`useClickOutside` + `useEscapeKey`, `.sam-glass-live` panel) is the closest precedent;
  `@simple-agent-manager/ui` `Popover` needs an anchor point and portal, which is more than a
  one-sentence note needs.
- Design guidance that asked for a one-sentence subtitle: `.claude/skills/sam-glass/SKILL.md`
  step 3. Updated along with `docs/guides/sam-glass-design-system.md` principles.

## Variants considered

1. One row: Inbox + ? + chips + ⋯ (chosen; exactly what was asked, header ~2x shorter).
2. Title row with ⋯ at right, chips below (still two rows).
3. Drop the title entirely on desktop like mobile (loses page identity beside the nav).

## Checklist

- [x] Remove the subtitle; put the sentence behind a `?` note beside the title (`InboxHelpButton`)
- [x] Put chips and ⋯ on the same row as the title on desktop; mobile unchanged
- [x] Unit test: purpose hidden by default, `?` opens it, Escape closes and refocuses, click outside closes
- [x] Playwright: one-row coordinates at 1280 and 800, note paints over panes, mobile/desktop screenshots
- [x] Update SAM Glass skill + design guide with the "less text" rule
- [x] Review fixes: ⋯ follows the last chip; "Back to Overview" icon-only between md and lg; ? note closes on focus loss; Playwright covers from-Overview at 800/1024px and the light theme
- [ ] PR, review, staging verification, merge, production deploy

## Acceptance criteria

- Desktop inbox header is one row: title, `?`, chips, ⋯ (Playwright coordinate assertions)
- "What your agents need from you…" is not shown until `?` is pressed (unit + Playwright)
- Mobile header is unchanged (mobile audit screenshots)

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped in [#2942](https://github.com/raphaeltm/simple-agent-manager/pull/2942).
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 1 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
