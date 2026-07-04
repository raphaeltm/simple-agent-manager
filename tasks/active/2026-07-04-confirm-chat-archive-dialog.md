# Confirm Chat Archive Dialog

## Problem

The circular lifecycle button above the project chat input morphs from "Interrupt agent" to "Archive conversation" when the agent appears idle. The archive state currently calls the archive handler immediately. On mobile this sits close to the pause/interrupt flow, so an accidental tap can archive the conversation and remove the active workspace context without the confirmation already used by the header "Complete" action.

## Research Findings

- `apps/web/src/components/project-message-view/CompletionDock.tsx` owns the circular lifecycle control. The center button uses `onClick={showArchiveInCenter ? onArchive : onInterrupt}`, so idle archive clicks bypass confirmation. Addressed by checklist items 1-3.
- `apps/web/src/components/project-message-view/SessionHeader.tsx` already uses the shared `Dialog` component for "Mark task as complete?", with clear copy, Cancel, and a destructive confirmation button. Reuse this pattern for system consistency. Addressed by checklist item 2.
- `apps/web/tests/unit/components/CompletionDock.test.tsx` currently asserts that clicking the idle archive button calls `onArchive` immediately. That test must be inverted to cover the confirmation flow. Addressed by checklist item 4.
- `apps/web/tests/playwright/completion-dock-audit.spec.ts` already audits the real project chat dock in mobile and desktop, light and dark themes. Extend the idle scenario to capture the confirmation dialog and assert no overflow. Addressed by checklist item 5.
- `.claude/rules/26-project-chat-first.md` requires testing the project chat flow first. This change is directly in project chat and should be validated there. Addressed by checklist items 5 and 7.
- `.claude/rules/06-technical-patterns.md` and `UI_UX_SPECIALIST.md` require effect-collision analysis for interactive handlers. `CompletionDock` has effects for animation, resize, and reduced-motion only; the new confirmation state should not overlap with those effect dependencies. Addressed by checklist item 6.
- Relevant retained task `tasks/archive/2026-03-15-project-chat-header-revamp.md` introduced the top header completion confirmation. It establishes the wording pattern that completion deletes the workspace and cannot be undone. Addressed by checklist item 2.

## Interaction Variants Considered

1. Add confirmation inside `CompletionDock` and only call `onArchive` from the dialog confirm button.
2. Lift confirmation state into `ProjectMessageView` and keep `CompletionDock` purely presentational.
3. Replace the archive button with a two-step inline state in the dock, such as "Tap again to archive".

Selected direction: variant 1. It keeps the safety behavior attached to the destructive control, reuses the existing dialog pattern, and avoids pushing dock-specific UI state into the larger chat component. Variant 2 spreads local UI state into a busier parent. Variant 3 is easier to miss on mobile and is less consistent with the existing completion confirmation.

## Implementation Checklist

- [x] Add archive confirmation state to `CompletionDock` without changing interrupt behavior.
- [x] Render a shared `Dialog` for idle archive confirmation with clear workspace-loss/destructive copy, Cancel, and an archive confirm action.
- [x] Keep in-flight archive behavior disabled and make the confirmation action show the existing loading state when `archiving` is true.
- [x] Update `CompletionDock` unit tests so archive requires confirmation, cancel does not archive, and interrupt still fires immediately while working.
- [x] Extend or run the completion dock Playwright audit to cover the confirmation dialog on mobile and desktop.
- [x] Document effect-collision analysis in this task file after implementation.
- [ ] Run focused unit tests, visual audit, lint/typecheck/test/build as required by `/do`.

## Acceptance Criteria

- [x] Clicking the idle circular "Archive conversation" control opens a confirmation dialog instead of calling `onArchive`.
- [x] Clicking Cancel or closing the dialog does not archive the conversation.
- [x] Clicking the dialog confirmation calls the existing archive handler exactly once.
- [x] The working "Interrupt agent" button remains immediate and does not show archive confirmation.
- [x] The dialog follows the existing header completion confirmation pattern and remains usable on 375px mobile and 1280px desktop without horizontal overflow.
- [x] Existing archive loading and error display behavior remains intact.

## Implementation Notes

- `CompletionDock` now owns local archive-confirmation state. Idle center-button clicks open the dialog; working-state clicks still call `onInterrupt()` immediately.
- The confirmation dialog uses `Dialog` and `Button` from `@simple-agent-manager/ui` with destructive button styling and copy warning that uncommitted workspace progress tied to the conversation may be lost.
- The archive confirm button calls the existing `onArchive` callback and reflects the existing `archiving` prop with disabled/loading text. Cancel and backdrop/Escape close are disabled while archiving is in flight.
- `ProjectMessageView` now has an integration test proving the parent `onCloseConversation` handler is not called until dialog confirmation.
- The completion dock Playwright audit now captures confirmation-dialog screenshots and appends viewport dimensions to screenshot names to avoid project-overwrite collisions.

## Effect-Collision Analysis

- Existing effects in `CompletionDock`: animation easing (`useEased`), width measurement (`useWidth`), reduced-motion media query (`usePrefersReducedMotion`), and the new `working` guard that closes archive confirmation if the center button morphs back to interrupt mode.
- New/modified handlers: `handleCenterClick` sets `archiveConfirmOpen` only when idle; otherwise it calls `onInterrupt`. `handleConfirmArchive` calls `onArchive`. `handleCloseArchiveConfirm` closes the dialog only when not archiving.
- Collision check: none of the animation, width, or media-query effects depend on `archiveConfirmOpen`, so they cannot undo the user click. The new `working` guard depends on `working`, not the click state; it only closes a stale archive dialog if the session becomes active again, which matches the visible control identity.

## Verification

- `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/CompletionDock.test.tsx tests/unit/components/project-message-view.test.tsx` — passed, 69 tests.
- Initial Playwright run failed because browsers were not installed; recovered with `npx playwright install chromium`.
- Second Playwright run failed because Chromium dependencies were missing (`libnspr4.so`); recovered with `npx playwright install-deps chromium`.
- `npx playwright test tests/playwright/completion-dock-audit.spec.ts --project="iPhone SE (375x667)" --project="Desktop (1280x800)"` — passed, 16 tests.
- Visual inspection: `.codex/tmp/playwright-screenshots/completion-dock-archive-confirm-dark-mobile-375x667.png`, `.codex/tmp/playwright-screenshots/completion-dock-archive-confirm-dark-desktop-1280x800.png`, and `.codex/tmp/playwright-screenshots/completion-dock-archive-confirm-light-mobile-375x667.png` show no clipping, overlap, or horizontal overflow.
- `pnpm --filter @simple-agent-manager/web typecheck && pnpm --filter @simple-agent-manager/web lint` — passed; lint emitted existing warning-only output.

## References

- `apps/web/src/components/project-message-view/CompletionDock.tsx`
- `apps/web/src/components/project-message-view/index.tsx`
- `apps/web/src/components/project-message-view/SessionHeader.tsx`
- `apps/web/tests/unit/components/CompletionDock.test.tsx`
- `apps/web/tests/playwright/completion-dock-audit.spec.ts`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/rules/26-project-chat-first.md`
- `.claude/rules/06-technical-patterns.md`
- `tasks/archive/2026-03-15-project-chat-header-revamp.md`
