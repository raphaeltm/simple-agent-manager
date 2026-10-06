# Frontend Interaction Accessibility Hardening

## Problem Statement

CTO frontend review identified high-confidence interaction/accessibility gaps around shared Dialog/Dropdown primitives and destructive admin/chat actions. This task keeps scope narrow: fix non-breaking accessibility and confirmation consistency issues while preserving current visual design and workflows.

Explicit constraint: open a PR but do not merge it.

## Research Findings

- `packages/ui/src/components/Dialog.tsx` provides the shared dialog primitive. It currently closes on Escape, locks scroll, and focuses the panel, but uses a hard-coded `aria-labelledby="dialog-title"` whether or not consumers provide that ID. It does not restore focus to the opener or trap Tab focus inside the modal.
- `packages/ui/tests/Dialog.test.tsx` already covers portal rendering, backdrop click, Escape, scroll lock, sizing, and cleanup. It needs focused interaction regression coverage for accessible naming/focus handling.
- `packages/ui/src/components/DropdownMenu.tsx` provides the shared dropdown primitive. It supports click open/close, Escape, outside click, ArrowUp/ArrowDown, menu roles, and custom trigger label. It currently focuses index `0` on open and arrow navigation traverses all items, including disabled ones. It only handles ArrowDown from the trigger, not ArrowUp/Enter/Space.
- `packages/ui/tests/DropdownMenu.test.tsx` covers baseline rendering, open/close, click outside, danger/disabled item attributes, arrow wrapping, and custom trigger labels. It needs tests for open keys and disabled-item focus skipping.
- `apps/web/src/components/project-message-view/CompletionDock.tsx` already uses a shared `Dialog` confirmation for the archive conversation control, with Playwright coverage in `apps/web/tests/playwright/completion-dock-audit.spec.ts` and unit coverage in `apps/web/tests/unit/components/project-message-view.test.tsx`.
- `apps/web/src/components/project-message-view/SessionHeader.tsx` already uses a shared `Dialog` confirmation for `Complete & Delete` after the top-level `Complete` button is clicked. It exposes `completeError` near the lifecycle controls. If touched, add regression coverage around completion errors.
- Relevant user/project policy from SAM knowledge: destructive chat archive controls must require explicit confirmation; chat archive and complete controls must clean up consistently. This PR should not alter backend cleanup semantics.
- Relevant `/do` UI rule: any `apps/web` or `packages/ui` change requires local Playwright visual audit at mobile and desktop viewports.
- Relevant history: `tasks/archive/2026-04-28-sam-markdown-accessibility-polish.md` and `.claude/rules/17-ui-visual-testing.md` emphasize keyboard accessibility and screenshot-backed validation for UI changes.

## Implementation Checklist

- [x] Update `Dialog` with optional accessible label props and robust fallback behavior that does not create broken ARIA references.
- [x] Add focus restoration and basic Tab/Shift+Tab focus containment for open dialogs without changing visual structure.
- [x] Add `Dialog` unit tests covering accessible naming, focus restoration, and Tab wrapping.
- [x] Update `DropdownMenu` keyboard behavior to open on Enter/Space/ArrowDown/ArrowUp and focus the first/last enabled item as appropriate.
- [x] Skip disabled menu items during arrow navigation and avoid opening onto disabled items.
- [x] Add `DropdownMenu` unit tests for open keys and disabled-item navigation.
- [x] Inspect chat archive/complete controls after primitive changes; only touch call sites if needed to preserve/clarify confirmation or error behavior.
- [x] If chat lifecycle error handling is touched, add at least one regression test proving failed complete/archive actions keep the confirmation/error state safe.
- [x] Run package/app targeted tests.
- [x] Run local Playwright visual audit for affected dialog/dropdown/chat confirmation surfaces at mobile and desktop.
- [x] Run broader quality checks required before PR.
- [x] Use UI/UX and test-quality review before PR.
- [x] Open PR and do not merge.

## Acceptance Criteria

- Shared `Dialog` has a valid accessible name when provided and does not emit broken label references when not provided.
- Open dialogs keep keyboard focus within the modal and restore focus to the opener on close.
- Shared `DropdownMenu` can be opened using standard keyboard activation keys and navigates enabled menu items predictably.
- Disabled dropdown items remain unavailable and are skipped in keyboard navigation.
- Chat archive and complete/destructive controls still require explicit confirmation and preserve current workflows.
- Tests cover keyboard/focus/confirmation behavior and any touched chat lifecycle error handling.
- Relevant local checks and CI are green.
- PR is opened against `main` and left unmerged.

## References

- `packages/ui/src/components/Dialog.tsx`
- `packages/ui/src/components/DropdownMenu.tsx`
- `apps/web/src/components/project-message-view/CompletionDock.tsx`
- `apps/web/src/components/project-message-view/SessionHeader.tsx`
- `packages/ui/tests/Dialog.test.tsx`
- `packages/ui/tests/DropdownMenu.test.tsx`
- `apps/web/tests/unit/components/project-message-view.test.tsx`
- `.claude/rules/17-ui-visual-testing.md`
- `tasks/archive/2026-04-28-sam-markdown-accessibility-polish.md`


## Validation Notes

- Targeted UI tests passed: `pnpm --filter @simple-agent-manager/ui test -- Dialog.test.tsx DropdownMenu.test.tsx`.
- Targeted web regression passed: `pnpm --filter @simple-agent-manager/web test -- tests/unit/components/project-message-view.test.tsx`.
- Local visual audit passed for completion dock and portal dropdown surfaces at mobile/desktop viewports using existing Playwright audit specs. Screenshot viewer was unavailable in this sandbox due `bwrap: loopback: Failed RTM_NEWADDR`, so screenshot-backed claims are limited to the passing Playwright assertions and generated artifacts.
- Full quality gate passed: `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
- PR opened and intentionally left unmerged: https://github.com/raphaeltm/simple-agent-manager/pull/1600.
- PR preflight evidence block validated locally with `pnpm quality:preflight` after setting classifications to `cross-component-change` and `ui-change`.
- Task-completion validation: PASS. Research findings, implementation checklist, and acceptance criteria are covered by code diff and tests; no new UI-to-backend data path or multi-resource selection was introduced.
- UI/UX review: PASS. Selected the no-visual-change hardening variant; existing shared components and tokens preserved. Rubric scores: visual hierarchy 5, interaction clarity 5, mobile usability 4, accessibility 5, system consistency 5.
- Test-quality review: PASS. Added focused interaction tests for Dialog and Dropdown behavior plus a chat lifecycle completion-error regression. Tests follow existing Vitest/Testing Library patterns and exercise boundary behavior through component/API-client mocks with realistic session data.
