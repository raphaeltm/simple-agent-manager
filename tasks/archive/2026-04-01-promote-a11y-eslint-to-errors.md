# Promote a11y ESLint Rules from Warnings to Errors

## Problem

The 8 `jsx-a11y/*` rules in `.eslintrc.cjs` are set to `'warn'` severity. They were introduced as warnings for incremental adoption (see strengthen-eslint-configuration change). As of 2026-04-01, there are 72 remaining violations across the codebase.

## Goal

Fix all 72 violations and then promote the rules from `'warn'` to `'error'` so they are CI-blocking.

## Rules to Promote

- `jsx-a11y/click-events-have-key-events`
- `jsx-a11y/no-static-element-interactions`
- `jsx-a11y/label-has-associated-control`
- `jsx-a11y/no-autofocus`
- `jsx-a11y/no-noninteractive-element-interactions`
- `jsx-a11y/interactive-supports-focus`
- `jsx-a11y/no-interactive-element-to-noninteractive-role`
- `jsx-a11y/aria-role`

## Acceptance Criteria

- [x] All violations fixed (not suppressed with eslint-disable)
- [x] All 8 rules changed from `'warn'` to `'error'` for `apps/web`
- [x] `pnpm lint` passes with no a11y warnings or errors in `apps/web`

## Completion Note (2026-08-11)

Done in the ai-slop-debt-burndown PR.

By the time this was picked up, the count had drifted to 64 remaining
findings in `apps/web` (61 confirmed by a fresh `npx eslint apps/web` run at
start of work; the original 72-violation count from 2026-04-01 predates this
and this repo's config has moved from `.eslintrc.cjs` to the flat
`eslint.config.mjs` since). All were fixed with semantically-correct,
behavior-preserving changes (no `eslint-disable`, no `any`):

- **label-has-associated-control (21)**: mostly fixed via two rule-config
  additions rather than per-file edits — `controlComponents: ['Input']`
  (teaches the rule that `@simple-agent-manager/ui`'s `<Input>` always
  renders a native `<input>`, so `<label><Input/></label>` nesting is a real
  association) and `depth: 3` (the rule's default nesting search of 2 was one
  level too shallow to see label text rendered through an extra wrapper
  element, verified empirically before changing). The remaining
  sibling-label cases (`ScalingSettings`, `ProjectRuntimeConfigSection`,
  `GlobalAudioPlayer`, `TaskSubmitForm`) got `useId()` + `htmlFor`/`id`
  wiring, matching the existing `RepositoryAccessCombobox.tsx` precedent.
  `Nodes.tsx`'s "Node Size" text was changed from `<label>` to `<div>` since
  it describes a group of `VmSizeCard` buttons, not a single control.
- **click-events-have-key-events / no-static-element-interactions /
  no-noninteractive-element-interactions (35)**: dialog backdrop divs
  (`CommandPalette`, `GlobalCommandPalette`, `KeyboardShortcutsHelp`,
  `ConfirmDialog`, mobile workspace menu) got `aria-hidden="true"` — the
  jsx-a11y-documented exemption for "a click screen to close a dialog",
  verified each has a keyboard equivalent (Escape or a focusable close
  button). Pure click-boundary wrapper divs with no semantic meaning of
  their own (`NodeCard`'s dropdown/workspace-card wrappers,
  `ProjectSummaryCard`, `ZenPeekRail`, `WorkspaceCreateMenu`, and the
  equivalent test-harness wrapper divs in `NodeCard.test.tsx`,
  `NodeWorkspaceMiniCard.test.tsx`, `copy-button.test.tsx`) got
  `role="presentation"` (removes false interactive semantics from the
  wrapper while keeping its real interactive children in the accessibility
  tree). `ChatSessionList`'s `<li onClick>` became `<li><button>...</button></li>`
  (real native keyboard support instead of a hand-rolled `role="button"` —
  `<li role="button">` itself trips the separate, already-error-level
  `no-noninteractive-element-to-interactive-role` rule, which only allow-lists
  a specific role set for `<li>`). `CreateDirectoryDialog`'s backdrop was
  restructured into a decorative sibling of the dialog card (matching
  `ConfirmDialog`'s existing pattern) so the card no longer needs
  `stopPropagation`. `ChoosePathWizard`'s Escape/Tab-trap handler moved from
  a JSX `onKeyDown` on the `role="dialog"` element to a `document`-level
  listener in a `useEffect` (same technique `ConfirmDialog` already used) —
  `role="dialog"` is a non-interactive ARIA role, so a handler on the element
  itself is correctly rejected.
- **aria-role (2)**: fixed via `ignoreNonDOM: true` — `AcpConversationItemView`
  passes `role="user"|"agent"` to the custom `<MessageBubble>` component,
  which is an unrelated domain prop (verified never forwarded to a DOM
  node), not an ARIA role.
- **interactive-supports-focus (3)**: `tabIndex={-1}` added to the
  `role="option"` divs in `CommandPalette`/`GlobalCommandPalette` (ARIA
  combobox-listbox pattern — options are intentionally not in the natural
  tab order; keyboard nav goes through the search input's
  `aria-activedescendant`) and the `role="tablist"` container in
  `NotificationCenter`.
- **no-interactive-element-to-noninteractive-role (1)**: removed the
  contradictory `role="listitem"` from a native `<button>` in `Chats.tsx`.

New/extended behavioral tests: `ChatSessionList.test.tsx` (new),
`ChoosePathWizard.test.tsx` (new), extended `CommandPalette.test.tsx` /
`GlobalCommandPalette.test.tsx` for the new option-row keyboard handlers, and
fixed two pre-existing tests that had encoded the accessibility bugs as
expected behavior (`chats.test.tsx` asserted `role="listitem"` on the
buttons; `create-directory-dialog.test.tsx` asserted the backdrop styling was
on the `role="dialog"` element itself).
