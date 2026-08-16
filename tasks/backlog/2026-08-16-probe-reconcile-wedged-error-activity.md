# Extend probe reconciliation to sessions wedged in `activity='error'`

**Parent:** SAM idea `01M0644866Q0000M4HP39WNCZW`; deliberately scoped out of the
session-activity state machine PR (see `tasks/archive/2026-08-16-session-activity-state-machine.md`).

## Problem

`WORKING_ACTIVITIES` in `apps/api/src/durable-objects/project-data/session-state.ts` is
`['prompting', 'recovering']`, so the probe reconciler
(`session-activity-reconciliation.ts`) never selects a session wedged at
`activity='error'`. The pre-existing SQL-only heal (`reconcileStaleActivity`) DOES include
`'error'`, but it is blocked by the same live-heartbeat guard that motivated the probe — so
an `error` session on an awake, heartbeating agent is covered by neither path.

## Why it was scoped out

Flipping `error` → `idle` erases a user-visible error state (`status_error` drives the chat
status surface), so it is a product decision rather than a pure reconciliation fix. Doing it
blind inside the reliability PR risked hiding real agent errors from users.

## Acceptance criteria

- [ ] Decide the intended product behavior for a stale `error` state on a live agent:
      reconcile to idle, keep the error but re-arm idle scheduling, or leave as-is
- [ ] If reconciling: probe-confirm before clearing, and preserve `status_error` for display
- [ ] Regression test: `error` + live heartbeat + stale, with a discriminating control that
      a fresh `error` is not touched
- [ ] Confirm the three consumers (status UI, durable delivery, idle/sleep scheduling)
      behave correctly for whichever option is chosen
