# Automate text contrast on frosted SAM Glass panes

## Problem

Since PR #2506 every SAM Glass pane in the app is frosted: low fills (dark 0.42 / quiet 0.3, light
0.5 / 0.36) over the void's edge glow. Text contrast on panes was measured once by hand (median
background pixel behind every text element on the chat and project settings screens, 390 and
1280 wide, both themes: all text 4.5:1 or better except disabled buttons and the existing red
Delete button). Nothing in CI pins it, so a later token change (a lower quiet fill, a stronger
glow, a pane in a corner where two edge glows stack) can drop muted text below 4.5:1 unnoticed.

## Context

Raised as a MEDIUM finding by the ui-ux-specialist review of the frosted panes commit on
PR #2506. The hand measurement made text transparent, screenshotted, and compared each text
element's colour to the median pixel inside its box (a minimum pixel was too noisy: borders,
tab underlines and avatars fall inside text boxes).

## Acceptance Criteria

- [ ] A Playwright check in `apps/web/tests/playwright/sam-glass-chat-audit.spec.ts` (or a sibling
      spec) measures text on panes against the frosted background for the chat and one content
      page, at 390 and 1280, in both themes.
- [ ] Disabled controls and solid buttons are excluded by role/state, not by text.
- [ ] The check fails when `--sam-glass-v2-fill-quiet` is lowered far enough to drop muted text
      below 4.5:1 (prove it once).
- [ ] The existing white-on-`#ef4444` Delete button (3.76:1) is either fixed or filed separately.
