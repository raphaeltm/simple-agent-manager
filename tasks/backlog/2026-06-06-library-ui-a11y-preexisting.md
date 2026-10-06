# Pre-existing library UI accessibility & styling fixes

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** the invalid Tailwind class `bg-[rgba(8,15,12,0.5)]-inset` is gone. The light-mode
>   PR #1239 (`0c3f3e3be`) removed every occurrence; `apps/web/src` has no `]-inset` left.
> - **Still open:**
>   - `apps/web/src/components/library/FileActionsMenu.tsx`: the focus ring is only on the trigger
>     and the Preview item (:64, :94), not on Download, Edit Tags or Delete (:99-120). There is no
>     Escape to close and no `role="menu"`/`menuitem`; `aria-haspopup` is `"true"` rather than
>     `"menu"`, and there is no `aria-controls` (:66-67).
>   - `CreateDirectoryDialog.tsx`: it focuses the input and closes on Escape (:24-42), but has no
>     focus trap and does not return focus to the opener.
>   - `FileGridCard.tsx`: the tag markup is unchanged (:73-85); long tags still need truncation.
>   - Playwright coverage exists: `portal-overlay-audit.spec.ts:548` opens the menu and
>     `library-ui-audit.spec.ts:411, 523` open the new-folder dialog. Both specs are quarantined
>     (listed in `apps/web/tests/playwright/visual-audit-quarantine.txt`), so neither runs in CI.

## Problem

While implementing the client-side library search index (idea `01KTEGHZ8DA0ATXQAZTXGCEK54`,
PR on branch `sam/use-sam-mcp-tools-01kteg`), the `ui-ux-specialist` review surfaced
several accessibility and styling issues that are **pre-existing** in the library UI
(not introduced by the search PR) or live in components outside that PR's diff. They were
deferred to keep the frontend-only search PR focused. Each is a legitimate fix.

## Context

Discovered during /do Phase 5 specialist review of the library client-index search feature.
These findings were triaged as out-of-scope for that PR because they pre-date it and/or
touch files the search PR does not modify.

## Findings / Acceptance Criteria

- [ ] **FileActionsMenu**: add `FOCUS_RING` focus-visible styles to menu trigger and items
- [ ] **FileActionsMenu**: support `Escape` to close and `role="menu"` / `role="menuitem"` semantics
- [ ] **FileActionsMenu**: add `aria-haspopup="menu"` and `aria-expanded` / `aria-controls` on the trigger
- [ ] **CreateDirectoryDialog**: implement a focus trap and return focus to the opener on close
- [ ] **FileGridCard**: fix tag overflow (tags can overflow the card on narrow viewports)
- [ ] **Codebase-wide**: fix invalid Tailwind class `bg-[rgba(8,15,12,0.5)]-inset`
      (the `-inset` suffix on an arbitrary value is not valid Tailwind) — grep for
      `]-inset` across `apps/web/src`
- [ ] Add Playwright visual audit coverage at 375px + 1280px for FileActionsMenu open state
      and CreateDirectoryDialog

## References

- `.claude/rules/17-ui-visual-testing.md`
- ProjectLibrary.tsx filter panel container (`bg-[rgba(8,15,12,0.5)]-inset`)
- Idea `01KTEGHZ8DA0ATXQAZTXGCEK54`
