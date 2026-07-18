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

- [x] Extract reusable modal behavior in `packages/ui` for focus trapping, focus restore, body scroll lock, and background isolation.
- [x] Update `Dialog` to use the shared modal behavior while preserving public props and existing Escape/backdrop behavior.
- [x] Export the shared primitive/hook in a backward-compatible way for app consumers.
- [x] Update `MobileNavDrawer` to use the shared modal behavior or equivalent behavior without changing its visual structure or close animation semantics.
- [x] Add Dialog tests for background `inert`/`aria-hidden` isolation, restoration, focus entry, and hidden/disabled focus exclusions.
- [x] Add MobileNavDrawer tests for focus trap, focus restoration, body scroll lock, background isolation, Escape/backdrop semantics, inactive panel focus isolation, and mobile-sized rendering where practical.
- [x] Run targeted UI/web tests and full relevant quality checks.
- [x] Run Playwright visual audit for mobile and desktop drawer/dialog behavior and assert no horizontal overflow.
- [x] Run specialist reviews: `ui-ux-specialist`, `test-engineer`, `security-auditor`, `constitution-validator`.
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


## Validation evidence

- Unit: `pnpm --filter @simple-agent-manager/ui test` — 84/84 passed.
- Unit: `pnpm --filter @simple-agent-manager/web test -- mobile-nav-drawer.test.tsx nav-toggle.test.tsx` — 31/31 passed.
- Typecheck: `pnpm --filter @simple-agent-manager/ui typecheck` — passed.
- Typecheck: `pnpm --filter @simple-agent-manager/web typecheck` — passed.
- Lint: `pnpm --filter @simple-agent-manager/ui lint` — passed.
- Lint: `pnpm --filter @simple-agent-manager/web lint` — passed with existing warnings and no errors.
- Build: `pnpm --filter @simple-agent-manager/ui build` — passed.
- Build: `pnpm --filter @simple-agent-manager/web build` — passed.
- Playwright visual audit: `pnpm --filter @simple-agent-manager/web exec playwright test tests/playwright/nav-toggle-audit.spec.ts --project='iPhone SE (375x667)' --project='Desktop (1280x800)'` — 24/24 passed after installing Playwright browsers/deps; screenshots written under `.codex/tmp/playwright-screenshots/`; tests include horizontal overflow assertions.

## Specialist review evidence

| Reviewer | Status | Outcome |
| --- | --- | --- |
| task-completion-validator | PASS | Research findings map to checklist and diff; acceptance criteria covered by Dialog/mobile-nav unit tests plus nav visual audit; no UI-backend or multi-resource path applies. |
| ui-ux-specialist | PASS | Visual structure preserved; mobile drawer keeps `w-[85vw] max-w-80`; Playwright mobile/desktop screenshots and overflow assertions passed. Rubric: hierarchy 4, interaction clarity 5, mobile usability 5, accessibility 5, system consistency 5. |
| test-engineer | PASS | Added behavioral tests for focus trap, focus restore, background isolation restoration, inactive panel focus isolation, ESC/backdrop regression preservation, and mobile width contract. |
| security-auditor | PASS | No credentials/auth/API changes; background isolation uses DOM `aria-hidden`/`inert` only and restores previous state on cleanup. No new secret exposure or cross-tenant surface. |
| constitution-validator | PASS | No hardcoded service URLs, credentials, env vars, or policy constants added. Existing animation timing and width classes were preserved rather than introducing new behavior constants. |
