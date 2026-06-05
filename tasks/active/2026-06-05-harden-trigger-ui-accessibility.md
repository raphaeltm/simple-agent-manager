# Harden Trigger UI Accessibility and Interaction Contracts

## Problem Statement

The trigger management UI exposes hidden controls to assistive technology, uses a custom dropdown without complete keyboard/error behavior, hides destructive mutation failures, and guesses execution pagination from page size instead of the API continuation contract. These are user-facing correctness bugs in `apps/web/src/components/triggers/*`, `apps/web/src/pages/ProjectTriggers.tsx`, `apps/web/src/pages/ProjectTriggerDetail.tsx`, and trigger UI tests.

## Post-Mortem

### What Broke

- The closed trigger drawer remains mounted with `role="dialog"`, `aria-modal="true"`, and focusable controls, so screen readers and keyboard users can encounter a modal that is visually closed.
- The project chat trigger dropdown declares menu semantics without menu keyboard behavior, swallows trigger load failures, and can overflow at the viewport edge.
- Execution cleanup/delete failures have no user-visible feedback for destructive or state-mutating controls.
- Trigger detail pagination ignores `nextCursor` and infers continuation from `executions.length === 20`.

### Root Cause

The UI relied on visual hiding and shallow existence tests instead of testing accessibility-tree and interaction contracts. The trigger dropdown used ARIA menu roles as styling hints instead of implementing the menu pattern. Execution mutation handlers only handled loading cleanup, not failure state. Pagination code did not model the API response continuation state already returned by `listTriggerExecutions()`.

### Timeline

- Trigger UI and cleanup controls were added in previous trigger tasks.
- URL-driven trigger drawer tests later verified only that edit text was absent when closed, leaving hidden dialog controls untested.
- Parent spot check found the issue on 2026-06-05.

### Why It Wasn't Caught

Tests were too shallow for the surface: they asserted text presence/absence but not `role=dialog`, hidden form controls, keyboard close behavior, mutation failure feedback, or exact pagination continuation behavior. The Playwright audit covered layout screenshots and overflow but not the affected interaction and accessibility states.

### Class of Bug

Accessibility and interaction-contract regressions hidden by visual-only or shallow DOM tests.

### Process Fix

This task adds focused behavioral tests for closed modal exposure, popover close/error behavior, destructive mutation feedback, and API pagination continuation. The existing Playwright trigger audit will also cover the changed mobile/desktop states with screenshot evidence.

## Research Findings

- `apps/web/src/components/triggers/TriggerForm.tsx` always returns a portal with a dialog and full form. It only visually translates closed state offscreen.
- `apps/web/src/pages/ProjectTriggers.tsx` drives `TriggerForm` from `?edit`; tests currently miss closed dialog/form-control exposure.
- `apps/web/src/components/triggers/TriggerDropdown.tsx` fetches on open, logs failures to `console.error`, uses `role="menu"`/`role="menuitem"` without Escape/focus/menu keyboard handling, and positions the fixed portal at `left: trigger.left`.
- `apps/web/src/components/triggers/ExecutionHistory.tsx` already defines `DELETABLE_STATUSES` without `running`, but cleanup/delete failures are silent and in-flight cleanup only disables its own button.
- `apps/web/src/pages/ProjectTriggerDetail.tsx` passes `offset` to `listTriggerExecutions()` and computes `hasMore` from returned page length, despite `ListTriggerExecutionsResponse` carrying `nextCursor`.
- `apps/web/src/lib/api/triggers.ts` currently accepts `limit`, `offset`, and `status` for execution listing; no API route/shared type change appears necessary if the page stores `nextCursor` while still passing offset.
- Existing tests: `apps/web/tests/unit/components/TriggerDropdown.test.tsx`, `apps/web/tests/unit/pages/project-triggers.test.tsx`, and `apps/web/tests/playwright/triggers-ui-audit.spec.ts`.
- Relevant archived task lessons: trigger chat dropdown was originally introduced as lightweight chat access; trigger execution cleanup added delete/cleanup controls and should preserve non-running deletion only; URL-driven state made trigger form open/close query-param driven.
- UI specialist variants considered:
  - Variant A: Unmount closed drawer and keep existing slide-in animation only for opened state.
  - Variant B: Keep drawer mounted for animation with `inert`, `aria-hidden`, tab suppression, and delayed unmount.
  - Variant C: Replace drawer with a shared dialog primitive.
- Selected direction: Variant A for the drawer because it removes the accessibility exposure directly with minimal code churn. For the dropdown, use a simple accessible popover/list with ordinary buttons and links rather than full menu semantics because the content is navigational and does not need composite widget arrow-key semantics.

## Implementation Checklist

- [ ] Update `TriggerForm` so the portal/dialog/form controls are not exposed when closed.
- [ ] Add/adjust `ProjectTriggers` tests asserting no closed `role=dialog`, no drawer `Name` input, no prompt textarea, and focus return on close where feasible.
- [ ] Update `TriggerDropdown` to use correct button/popover semantics, Escape close, outside-click close without double toggles, user-visible load failure state, retry, and viewport-clamped fixed positioning.
- [ ] Add/adjust `TriggerDropdown` tests for Escape close, outside click close, load failure + retry, navigation close behavior, and right-edge/small viewport clamping.
- [ ] Update `ExecutionHistory` mutation paths to show concise failure feedback, disable destructive controls while cleanup/delete requests are in flight, and keep running executions non-deletable.
- [ ] Add direct `ExecutionHistory` unit tests for cleanup success/failure, delete success/failure, disabled in-flight states, and running execution non-deletability.
- [ ] Update `ProjectTriggerDetail` pagination to honor `nextCursor` for `hasMore`, while preserving the existing API request contract unless a real API change is required.
- [ ] Add trigger detail page tests for exactly-full final page with `nextCursor: null` and multi-page case with `nextCursor` present.
- [ ] Update the Playwright trigger UI audit for changed desktop/mobile states, including dropdown error/edge positioning or equivalent practical coverage.
- [ ] Run targeted trigger unit tests.
- [ ] Run `pnpm --filter @simple-agent-manager/web lint`.
- [ ] Run `pnpm --filter @simple-agent-manager/web typecheck`.
- [ ] Run relevant Playwright trigger UI audit on mobile and desktop and capture screenshot evidence.
- [ ] Use `$ui-ux-specialist` rubric before PR.

## Acceptance Criteria

- [ ] With `ProjectTriggers` rendered without `?edit`, no trigger drawer dialog or hidden drawer form controls are in the accessibility tree.
- [ ] Closing the trigger drawer removes the dialog/form controls and returns focus to the opening control where practical.
- [ ] The trigger dropdown closes on Escape and outside click, exposes accessible popup semantics, shows trigger load failure with retry, and stays within small/right-edge viewports.
- [ ] Execution cleanup/delete successes refresh execution data; failures show visible feedback; mutation controls are disabled while in flight; running executions cannot be deleted from UI.
- [ ] Trigger detail uses API continuation state so an exactly full final page does not show `Load more`, and a response with continuation does.
- [ ] Unit tests cover the regressions and changed interactions.
- [ ] Playwright mobile and desktop trigger audit passes with screenshots and no horizontal overflow.
- [ ] Web lint and typecheck pass.

## References

- User task: SAM task `01KTASSHK5QS8G1BPF61MD85FN`
- `.claude/rules/02-quality-gates.md`
- `.claude/rules/04-ui-standards.md`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/17-ui-visual-testing.md`
- `.claude/agents/ui-ux-specialist/UI_UX_SPECIALIST.md`
