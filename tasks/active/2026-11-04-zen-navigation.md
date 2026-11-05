# Desktop Zen navigation

User request: restore the layout controls and keep the revealed navbar open while switching global/project navigation. Green open PR and mock-data video in library; staging explicitly waived.

## Research

- AppShell Zen branch uses NavSidebar alone; DesktopSidebar owns the missing FocusModeToggle.
- NavSidebar carousel marks the outgoing panel inert. ZenPeekRail closes on blur regardless of pointer position.
- Existing focus-mode-audit exercises modes but never switches nav inside the peek.

## Checklist / acceptance

- [x] Reuse complete DesktopSidebar inside Zen peek.
- [x] Pointer and keyboard interaction survive global/project carousel switches.
- [x] Leaving the peek closes it; Escape dismisses; keyboard focus can keep it open.
- [x] Browser regression fails before fix and passes after.
- [x] Desktop/mobile mock-data screenshots reviewed, video uploaded to library.
- [ ] Web lint, typecheck, tests, build; independent specialist review.
- [ ] Open PR green; staging skipped per user; no merge requested.

## Variants

Reuse DesktopSidebar (selected: consistent controls, minimal duplication); add only layout tabs (partial duplication); latch peek after click (changes hover semantics).

## Validation evidence

- New restored-control browser assertion fails on original code; passes after fix.
- Desktop/mobile focus audit: 12 pass in first run, one repeated-switch test timed out under cold concurrent checks; isolated pointer rerun passed (29.2s), final recording run passed (30s). Keyboard/Escape and stress scenarios passed.
- Repeated-switch test has a 60s total bound for six animated switches plus screenshots; recording is opt-in through ZEN_RECORD_VIDEO.
- Light fixture asserts actual sam-light DOM theme. Screenshots inspected in both themes and mobile; no clipping, overflow or readability issues.
- Lint passes with three existing warnings; typecheck and Vite production build pass. Full web unit suite running.
- Independent local zen_review: implementation/browser PASS, no actionable findings. UI rubric 4/4/4/4/5. Completion pending full unit suite and green open PR.
- Library MP4: 01M6MG0KBWMC7VSHVRFFHKC62H; screenshot IDs recorded in PR evidence.

## Post-mortem

The original Focus Mode implementation (f1fa86644, #1375) rendered NavSidebar alone in Zen, omitting layout controls. Its blur handler dismissed when the carousel made the outgoing focused panel inert. Existing audits tested mode cycling and seam expansion without using the revealed menu. The expanded audit now tests the actual hover, carousel, visible exit controls, keyboard focus, and dismissal. Existing scoped guidance already requires these interaction checks, so no duplicate standing rule is added.
