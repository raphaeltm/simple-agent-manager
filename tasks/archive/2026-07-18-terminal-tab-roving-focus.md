# Accessible terminal tab roving focus

## Problem

The terminal tab bar exposes terminal sessions as tabs, but each tab is currently tabbable. This does not implement the expected roving tabindex pattern for a `tablist`, and the existing keyboard test only fires an arrow key without asserting focus movement.

## Research findings

- `packages/terminal/src/components/TabBar.tsx` renders the terminal `role="tablist"` and maps sorted terminal sessions into `TabItem`.
- `packages/terminal/src/components/TabItem.tsx` renders each tab with `role="tab"`, `aria-selected`, `aria-label`, activation on click/Enter/Space, and currently hardcodes `tabIndex={0}` for every tab.
- `packages/terminal/tests/unit/components/TabBar.test.tsx` already covers rendering, click activation, Enter/Space activation, close buttons, and basic ARIA attributes. The arrow-key test is non-discriminating.
- `packages/ui/src/components/Tabs.tsx` provides an existing roving focus pattern for ArrowLeft/ArrowRight/Home/End at the shared UI level.
- Workspace-level tests in `apps/web/tests/unit/components/workspace-tab-strip.test.tsx` cover roles/labels for composed workspace tabs, but this remediation is scoped to the terminal package and should not change workspace layout or terminal protocol.

## Implementation checklist

- [x] Add roving tabindex support to terminal tabs: active tab is tabbable, inactive tabs are not.
- [x] Add ArrowRight/ArrowLeft/Home/End keyboard handling on the terminal tablist.
- [x] Keep Enter/Space activation behavior unchanged.
- [x] Keep close buttons keyboard-accessible and avoid changing session protocol or layout.
- [x] Add discriminating tests for tabindex, ArrowRight/ArrowLeft wrapping, Home/End, active tab focus after active-session changes, close/remove edge behavior, and ARIA roles/labels.
- [x] Run terminal package tests and relevant repo quality checks.
- [x] Document why component-level tests are sufficient if no rendered layout changes are made.

## Acceptance criteria

- Only the active terminal tab participates in sequential tab order.
- ArrowRight and ArrowLeft move focus among terminal tabs and wrap at the ends.
- Home and End move focus to the first and last terminal tabs.
- Changing the active session updates the tabbable tab and focuses the newly active tab when focus was already inside the tablist.
- Removing/closing the focused tab leaves a valid tabbable tab and focus target when tabs remain.
- Screen-reader semantics remain intact: `tablist`, `tab`, `aria-selected`, and terminal tab labels.
- No terminal session protocol changes.
- PR states this is non-breaking and includes test evidence.

## Verification notes

- Component-level tests are sufficient for this remediation because the implementation changes keyboard focus management only. It does not change terminal protocol, CSS styles, dimensions, layout structure, visual content, or rendered terminal output.
- Verified with `pnpm --filter @simple-agent-manager/terminal test -- tests/unit/components/TabBar.test.tsx`, full terminal tests, terminal typecheck/lint, and full repo `pnpm lint && pnpm typecheck && pnpm test && pnpm build`.
