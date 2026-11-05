# Desktop Zen navigation

User request: restore the layout controls and keep the revealed navbar open while switching global/project navigation. Green PR and mock-data video in library; staging explicitly waived.

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
- [x] Web lint, typecheck, tests, build; independent specialist review.
- [x] PR created with review, screenshot and recording evidence. Remaining CI/review/release gates are tracked in the PR and local workflow state; staging explicitly waived.

## Variants

Reuse DesktopSidebar (selected: consistent controls, minimal duplication); add only layout tabs (partial duplication); latch peek after click (changes hover semantics).

## Validation evidence

- New restored-control browser assertion fails on original code; passes after fix.
- Desktop/mobile focus audit: 12 pass in first run, one repeated-switch test timed out under cold concurrent checks; isolated pointer rerun passed (29.2s), final recording run passed (30s). Keyboard/Escape and stress scenarios passed.
- Repeated-switch test has a 60s total bound for six animated switches plus screenshots; recording is opt-in through ZEN_RECORD_VIDEO.
- Light fixture asserts actual sam-light DOM theme. Screenshots inspected in both themes and mobile; no clipping, overflow or readability issues.
- Lint passes with three existing warnings; typecheck and Vite production build pass. Full web suite: 390 files / 4,883 tests passed (812.52s). Wrapper returned 143 after full passing summary; affected-component rerun: 54 tests passed with exit 0; CI checks the full suite.
- Independent local zen_review: implementation/browser PASS, no actionable findings. UI rubric 4/4/4/4/5. Implementation and browser validation complete; release gates remain tracked in the PR.
- Library MP4: 01M6MG0KBWMC7VSHVRFFHKC62H; screenshot IDs recorded in PR evidence.

## Post-mortem

The original Focus Mode implementation (f1fa86644, #1375) rendered NavSidebar alone in Zen, omitting layout controls. Its blur handler dismissed when the carousel made the outgoing focused panel inert. Existing audits tested mode cycling and seam expansion without using the revealed menu. The expanded audit now tests the actual hover, carousel, visible exit controls, keyboard focus, and dismissal. Existing scoped guidance already requires these interaction checks, so no duplicate standing rule is added.

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2532. Desktop/mobile evidence: PR comment #issuecomment-6645711930. Final MP4 library file: 01M6MG0KBWMC7VSHVRFFHKC62H. Staging waived; merge after all required gates (direct fix request is authorization under policy d60830e2).

## Release tracking

Implementation is archived per /do Phase 4 after local validation and independent review. CI, best-effort CodeRabbit, merge and basic production smoke remain required workflow gates and are tracked in the live PR. This archive does not claim release is complete.
