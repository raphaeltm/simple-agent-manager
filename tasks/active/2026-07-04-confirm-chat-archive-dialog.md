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

- [ ] Add archive confirmation state to `CompletionDock` without changing interrupt behavior.
- [ ] Render a shared `Dialog` for idle archive confirmation with clear workspace-loss/destructive copy, Cancel, and an archive confirm action.
- [ ] Keep in-flight archive behavior disabled and make the confirmation action show the existing loading state when `archiving` is true.
- [ ] Update `CompletionDock` unit tests so archive requires confirmation, cancel does not archive, and interrupt still fires immediately while working.
- [ ] Extend or run the completion dock Playwright audit to cover the confirmation dialog on mobile and desktop.
- [ ] Document effect-collision analysis in this task file after implementation.
- [ ] Run focused unit tests, visual audit, lint/typecheck/test/build as required by `/do`.

## Acceptance Criteria

- [ ] Clicking the idle circular "Archive conversation" control opens a confirmation dialog instead of calling `onArchive`.
- [ ] Clicking Cancel or closing the dialog does not archive the conversation.
- [ ] Clicking the dialog confirmation calls the existing archive handler exactly once.
- [ ] The working "Interrupt agent" button remains immediate and does not show archive confirmation.
- [ ] The dialog follows the existing header completion confirmation pattern and remains usable on 375px mobile and 1280px desktop without horizontal overflow.
- [ ] Existing archive loading and error display behavior remains intact.

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
