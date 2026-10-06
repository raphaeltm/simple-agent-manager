# Diagnosis Runner Cancellation and Terminal Race Postmortem

## Summary

The durable admin diagnosis runner shipped with a cancellation state that the production D1 table
could not persist. It also allowed a model/tool completion that resumed after cancellation or a hard
deadline to overwrite the winning terminal state.

## Impact

- Cancelling an active run could fail at the database `CHECK` constraint.
- A cancellation/deadline that landed during an external await could later become `succeeded`.
- The late success path could create a diagnosis row even though the administrator had cancelled the
  run.
- Diagnosis detail refreshes silently omitted events beyond the first page, obscuring the evidence
  needed to understand these transitions.

## Root Cause

Migration `0103_debug_diagnosis_runs.sql` constrained `status` to `queued`, `running`, `succeeded`,
or `failed`. The later runner implementation added `cancelled` only to TypeScript/Drizzle and wrote it
directly to the checked column.

Separately, `completeRun()` and `finish()` updated rows by ID without an active-state predicate.
Durable Objects can interleave whenever code awaits I/O, so the model/tool request created a real
window for cancel/deadline code to win and then be overwritten.

## Why Tests Missed It

- Unit tests exercised current TypeScript contracts or ad-hoc schemas instead of applying the shipped
  migration chain and writing `cancelled`.
- Cancellation tests ran before the alarm's external step rather than suspending the step, committing
  cancellation, and then releasing the late result.
- UI fixtures returned a cursor but did not require the client to fetch the next event page.

## Correction

- Add a canonical `run_status` column with all valid values and backfill it from the legacy checked
  column. Keep the legacy column compatible without recreating the FK-parent table.
- Publish diagnosis rows, the succeeded transition, and the terminal event in one guarded D1 batch.
- Use compare-and-set predicates for failed/cancelled/deadline transitions and suppress nonterminal
  events after cancellation/deadline.
- Query `limit + 1`, return a cursor only when more rows exist, and exhaust pages monotonically in the
  admin client.

## Process Fix

`.claude/rules/31-migration-safety.md` now requires persisted-enum changes to include a behavioral test
against the real migration chain. Long-running terminal-state changes must also include a
barrier-controlled late-completion test proving the compare-and-set loser cannot publish orphan data.
