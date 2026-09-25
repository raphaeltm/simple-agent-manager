# Mobile keyboard dismisses while typing in the agent profile edit modal

**Created:** 2026-09-24
**Status:** In progress
**Branch:** `sam/modal-open-edit-agent-vfgfwx`

## Problem

Reported from a phone: opening the agent profile edit modal from the project-chat
cogwheel makes the form almost unusable. Typing in the profile Name field — or
searching the model list — dismisses the software keyboard repeatedly, and typed
characters are dropped.

The reporter's hypothesis was a React render loop. It is not a render loop; it is a
**focus-steal loop**.

## Research

### Root cause 1 — `useModalInteraction` re-runs on every parent render

`packages/ui/src/hooks/useModalInteraction.ts` owns the modal's focus trap, scroll
lock and background `inert` isolation. Its effect listed `onEscape` in the dependency
array:

```ts
}, [enabled, isolateBackground, lockScroll, modalRef, onEscape, restoreFocus]);
```

`Dialog` passes `onClose` straight through as `onEscape`, and essentially every caller
passes an inline arrow — `apps/web/src/pages/project-chat/ChatInput.tsx:597` is
`onClose={() => setEditProfileOpen(false)}`. An inline arrow is a new function identity
on every render of the parent, so the effect tore down and re-ran on **every** render of
the chat page.

Both halves of that cycle move focus:

```ts
// teardown
if (restoreFocus && previouslyFocused?.isConnected) previouslyFocused.focus(); // → the cogwheel
// setup
modal?.focus();                                                                // → the dialog shell
```

The focused `<input>` is blurred each time. On desktop that is an invisible flicker;
on a phone a blur closes the software keyboard.

The re-render driver is ordinary project-chat traffic: `useProjectWebSocket` fires
`onSessionEvent` for every session event across the project, plus
`useVisibilityAwarePoll` session-sync/reconcile ticks and the 2s provisioning poll.
`ChatInput`, `ProfileFormDialog` and `Dialog` are all unmemoized, so each of those
re-renders reaches the hook.

Blast radius: 46 inline-arrow `onClose` call sites across `apps/web` and the UI
packages, plus `MobileNavDrawer` and `TriggerForm`, which consume the hook directly.

### Root cause 2 — the form-populate effect was keyed on the profile object

`ProfileFormDialog`'s populate effect was keyed `[isOpen, profile]`. `agentProfiles` is
a TanStack cache entry shared by five surfaces (`useAgentProfiles`), so a background
refetch or a cross-surface mutation (`writeProfileToCache`) hands the dialog a new
object for the same row. That re-ran every `setX(profile.…)` and silently reverted
in-progress edits.

Narrower than root cause 1 — the app sets `refetchOnWindowFocus: false` and the
profiles query has no `refetchInterval` — but reachable via any profile mutation from
another surface, and it produces the same user-visible complaint (typed text vanishing).

### Browser reproduction

A temporary harness mounted the real `ProfileFormDialog` with a mock profile inside a
parent re-rendering every 500ms, driven by Playwright at an iPhone 13 viewport. Typing
`My New ` into the Name field:

| | focus retained | blur events | value landed |
|---|---|---|---|
| before | 0/12 samples | 1 | `My Ne` (characters dropped) |
| after  | 12/12 samples | 0 | `My New ` |

The harness was diagnostic scaffolding and was removed; the durable equivalents are the
regression tests below.

## Implementation Checklist

- [x] Read `onEscape` through a ref in `useModalInteraction`; drop it from the effect deps
- [x] Key `ProfileFormDialog`'s populate effect on `profile.id`, reading the row via a ref
- [x] Regression test: focus + typed text survive parent re-renders (`packages/ui/tests/Dialog-focus-stability.test.tsx`)
- [x] Control: Escape still closes after a re-render
- [x] Control: the ref calls the LATEST `onEscape`, not a stale capture
- [x] Regression test: edits survive a same-row identity change (`apps/web/tests/unit/profile-form-dialog-edit-stability.test.tsx`)
- [x] Control: switching to a different profile still repopulates
- [x] Control: opening the dialog still populates from the freshest row
- [x] Prove both fixes discriminating by reverting each separately
- [ ] Playwright visual audit at 375px and 1280px (rule 17)
- [ ] Specialist review (rule 25)
- [ ] Staging deploy and live verification (rule 13)

## Acceptance Criteria

- [x] Typing in the profile Name field is not interrupted by parent re-renders — verified
      by `Dialog-focus-stability.test.tsx`, which goes red with the fix reverted
- [x] Escape still closes the dialog, and calls the latest handler — two controls
- [x] A background refetch of the same profile row does not revert in-progress edits —
      verified by `profile-form-dialog-edit-stability.test.tsx`, red with the fix reverted
- [x] Switching profiles and reopening the dialog still load the correct row — two controls
- [ ] No visual regression in any modal at mobile and desktop viewports
- [ ] Editing a profile from the project-chat cogwheel works end-to-end on staging

## Verification

- `pnpm typecheck` — clean (19/19 tasks)
- `pnpm lint` — 0 errors (3 pre-existing warnings, none in touched files)
- `packages/ui` — 109/109 tests pass across 13 files
- `apps/web` — 3821/3821 tests pass across 315 files
- Discrimination: reverting the `useModalInteraction` fix reddens exactly the focus test
  (both Escape controls stay green); reverting the `ProfileFormDialog` fix reddens exactly
  the edit-stability test (both populate controls stay green)

## Notes

- The reporter's "render loop" read was reasonable but the mechanism is focus, not
  re-render volume — the re-renders themselves are expected and cheap.
- Fixing the hook rather than the 46 call sites is deliberate: an effect that owns a
  mount/unmount lifecycle must not depend on caller callback identity. Telling every
  caller to `useCallback` its `onClose` would be 46 chances to regress.
- SAM MCP `add_knowledge` failed 3x with "Network connection lost" during this task.
