# Improve modal isolation and mobile nav focus management

## Problem

The shared `Dialog` primitive traps focus and restores opener focus, but it does not isolate background content from the accessibility tree. `MobileNavDrawer` uses its own overlay implementation with Escape/backdrop close semantics, but lacks equivalent focus trap, focus restoration, body scroll lock, and background isolation. This creates inconsistent modal behavior across shared dialogs and mobile navigation.

## Research findings

- `packages/ui/src/components/Dialog.tsx` renders via a portal into `document.body`, uses `role="dialog"` and `aria-modal="true"`, closes on Escape/backdrop click, locks body scroll, focuses the dialog container, restores focus on close, and traps Tab inside the dialog.
- `packages/ui/tests/Dialog.test.tsx` already covers portal rendering, accessible naming, Escape/backdrop semantics, scroll locking, focus restoration, and Tab trapping.
- `apps/web/src/components/MobileNavDrawer.tsx` renders a custom portal drawer with `role="dialog"`, `aria-modal="true"`, Escape close, backdrop close, and close animation, but no focus trap/restore/background isolation.
- `apps/web/tests/unit/components/mobile-nav-drawer.test.tsx` covers rendering, active nav state, navigation, sign-out, backdrop/close/Escape behavior, and command palette omission.
- `apps/web/tests/unit/components/nav-toggle.test.tsx` covers mobile nav toggle behavior in project/global nav contexts.
- `.claude/rules/15-nav-parity.md` requires reviewing mobile and desktop nav together when touching mobile navigation.
- `specs/019-ui-overhaul/research.md` documents the existing custom overlay pattern and avoids adding a new overlay dependency for these primitives.
- `specs/024-tailwind-adoption/tasks.md` notes prior Dialog and MobileNavDrawer Tailwind migrations that should preserve existing visual classes.

## Implementation checklist

- [ ] Extract reusable modal behavior in `packages/ui` for focus trapping, focus restore, body scroll lock, and background isolation.
- [ ] Update `Dialog` to use the shared modal behavior while preserving public props and existing Escape/backdrop behavior.
- [ ] Export the shared primitive/hook in a backward-compatible way for app consumers.
- [ ] Update `MobileNavDrawer` to use the shared modal behavior or equivalent behavior without changing its visual structure or close animation semantics.
- [ ] Add Dialog tests for background `inert`/`aria-hidden` isolation, restoration, focus entry, and hidden/disabled focus exclusions.
- [ ] Add MobileNavDrawer tests for focus trap, focus restoration, body scroll lock, background isolation, Escape/backdrop semantics, inactive panel focus isolation, and mobile-sized rendering where practical.
- [ ] Run targeted UI/web tests and full relevant quality checks.
- [ ] Run Playwright visual audit for mobile and desktop drawer/dialog behavior and assert no horizontal overflow.
- [ ] Run specialist reviews: `ui-ux-specialist`, `test-engineer`, `security-auditor`, `constitution-validator`.
- [ ] Create a non-breaking PR and do not merge it.

## Acceptance criteria

- Shared `Dialog` remains source-compatible for current callers.
- Dialog background content is isolated from assistive technology while open and restored after close/unmount.
- Dialog focus stays inside the dialog and restores to the opener on close.
- MobileNavDrawer gains equivalent focus trap, focus restoration, scroll lock, and background isolation.
- Escape and backdrop click behavior remains unchanged for both Dialog and MobileNavDrawer.
- MobileNavDrawer visual layout and animation classes remain stable.
- Accessibility/keyboard tests cover the new behavior.
- Playwright visual audit passes on mobile and desktop with no horizontal overflow.
- PR clearly states no breaking changes and includes test/visual evidence.
