# Trigger List Delete Action

## Problem
A user reported it feels "impossible / not intuitive" to delete a trigger. The trigger **detail** page has a working delete button + confirm modal, but the trigger **list** page (`ProjectTriggers.tsx`) has no delete affordance. The `TriggerCard` overflow (⋮) menu offers Edit, Run Now, Pause/Resume, and View History — but no Delete.

## Research Findings
- **Backend**: `DELETE /api/projects/:projectId/triggers/:triggerId` fully works (`apps/api/src/routes/triggers/crud.ts`)
- **API client**: `deleteTrigger(projectId, triggerId)` already exported from `apps/web/src/lib/api/triggers.ts:56`
- **Detail page pattern**: `ProjectTriggerDetail.tsx` has a confirm modal (lines 392-426) using `confirmDelete` state, `glass-modal` styling, `role="alertdialog"`, Cancel + Delete buttons
- **TriggerCard**: Accepts `onEdit`, `onRunNow`, `onTogglePause`, `onViewHistory` — no `onDelete`
- **Overflow menu**: Portal-based dropdown with 4 items (Edit, Run Now, Pause/Resume, View History)
- **Existing tests**: `tests/unit/components/TriggerDropdown.test.tsx` shows testing patterns; `tests/playwright/triggers-ui-audit.spec.ts` exists for visual audits

## Implementation Checklist
- [ ] **TriggerCard.tsx**: Add `onDelete?: (trigger: TriggerResponse) => void` prop
- [ ] **TriggerCard.tsx**: Add `Trash2` import from lucide-react
- [ ] **TriggerCard.tsx**: Add a visual separator (`border-t`) before the Delete menu item
- [ ] **TriggerCard.tsx**: Add destructive-styled Delete button at bottom of overflow menu (red text, Trash2 icon)
- [ ] **ProjectTriggers.tsx**: Import `deleteTrigger` from API client
- [ ] **ProjectTriggers.tsx**: Add `confirmDeleteTarget` state for the trigger pending deletion
- [ ] **ProjectTriggers.tsx**: Add `handleDelete` callback that calls `deleteTrigger`, toasts, refreshes via `loadTriggers()`
- [ ] **ProjectTriggers.tsx**: Render confirm dialog (reuse pattern from detail page) when `confirmDeleteTarget` is set
- [ ] **ProjectTriggers.tsx**: Wire `onDelete` prop to TriggerCard, setting confirmDeleteTarget
- [ ] **Behavioral test**: Delete opens confirmation dialog
- [ ] **Behavioral test**: Confirming calls deleteTrigger and removes the card
- [ ] **Behavioral test**: Cancel closes dialog without calling deleteTrigger
- [ ] **Playwright visual audit**: Overflow menu with Delete item at mobile (375px) and desktop (1280px)
- [ ] **Playwright visual audit**: Confirm dialog at mobile (375px) and desktop (1280px)

## Acceptance Criteria
- [ ] TriggerCard overflow menu shows a "Delete" item at the bottom, visually separated with danger/red styling
- [ ] Clicking Delete opens a confirmation dialog (never deletes without confirmation)
- [ ] Confirming deletion calls `deleteTrigger(projectId, triggerId)`, toasts success, refreshes list via React state (no page reload)
- [ ] Cancelling the dialog does nothing
- [ ] Error during deletion shows error toast
- [ ] Detail page delete remains unchanged
- [ ] Behavioral tests pass for the full delete flow
- [ ] Playwright visual audit passes at both viewports

## References
- Idea: 01KWF80N3F10K4FEFF61EXEPZS
- `.claude/rules/16-no-page-reload-on-mutation.md`
- `.claude/rules/17-ui-visual-testing.md`
