# Distinguish an auto-paused trigger from one the user paused

## Problem

The backend auto-pauses a trigger after N consecutive failures
(`TRIGGER_AUTO_PAUSE_AFTER_FAILURES`, `apps/api/src/services/trigger-admission.ts`),
but it writes the **identical** `status = 'paused'` that a user gets from
clicking Pause. `TriggerResponse` (`packages/shared/src/types/trigger.ts`) has no
`pausedReason`, `autoPaused` or `consecutiveFailureCount` field, so the UI cannot
tell the two apart.

The trigger card used to paper over this with a hedged banner on **every** paused
trigger:

> Paused — may be due to consecutive failures

That claim is false for a trigger the user just paused by hand, so it was removed
on 2026-08-11 (branch `sam/see-trigger-page-goes-06qjzh`). Removing it was the
right call — the UI should not guess — but it leaves a real gap: **there is now
no signal anywhere, list or detail, telling a user their trigger stopped itself
because it kept failing.** A trigger can silently stop running and look
indistinguishable from one that was deliberately paused.

## Why this needs backend work

This cannot be fixed in the web app alone. The distinguishing information does
not exist in the API response. The list page has no execution history to infer
from either; only the detail page does, and inference would be guessing again.

## Proposed shape

1. Add a persisted reason at the point the status flips — `trigger-admission.ts`
   already knows it is auto-pausing, so it can record `paused_reason='auto_failures'`
   alongside `status='paused'`. A user-initiated pause records `'manual'`.
   Additive column; see `.claude/rules/31-migration-safety.md` (`ALTER TABLE ADD
COLUMN`, never a table recreation — `triggers` is a CASCADE child of
   `projects`).
2. Surface it on `TriggerResponse`, optionally with `consecutiveFailureCount`.
3. Render a **precise, unhedged** signal only when the reason is `auto_failures`,
   linking to the execution history that explains it. No "may be".

## Acceptance Criteria

- [ ] Auto-pause and manual pause are distinguishable in `TriggerResponse`
- [ ] Additive migration only (no `DROP TABLE`); `pnpm quality:migration-safety` green
- [ ] The card/detail signal renders ONLY for an auto-paused trigger, and its
      wording asserts nothing the data does not support
- [ ] Behavioral test: a manually-paused trigger renders no failure claim; an
      auto-paused one does
- [ ] Regression test at the admission layer asserting the reason is persisted
      when the failure threshold trips

## References

- Removal context and rationale: `apps/web/tests/unit/components/TriggerCardActions.test.tsx`
  ("does not claim a paused trigger failed")
- `apps/api/src/services/trigger-admission.ts` — the auto-pause write
- `.claude/rules/42-no-untracked-degrading-placeholders.md` — this task is the
  tracking record for the removed signal
