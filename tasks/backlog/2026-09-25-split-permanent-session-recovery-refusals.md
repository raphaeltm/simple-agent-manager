# Give permanent session-recovery refusals their own names

> **Reconciliation 2026-10-05:** Pointer correction only. #2230 (`ee80b0ee0`) rewrote
> `apps/api/src/services/session-recovery.ts` (`createRecoveryTask` became
> `reactivateSleepingTask`; the file is now 370 lines), so the 2026-09-30 block's
> `session-recovery.ts:~372-392` and `:456` now read `:188` (`placement_unsatisfiable`), `:207-208`
> (`placement_credentials_missing`) and `:275` (`session_recovery_placement_lookup_failed`). The
> reason codes and logic are unchanged; still open as described.

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:**
>   - A `retry`/`report`/`drop` action table that consumers branch on:
>     `apps/api/src/services/session-recovery-refusals.ts` (module from PR #2145, table from
>     PR #2155 `371801cce`).
>   - Producer split: `stored_resource_plan_invalid` (`session-recovery-request.ts:76-124`),
>     `placement_unsatisfiable` and `placement_credentials_missing` (`session-recovery.ts:~372-392`),
>     and the generic catch is now `session_recovery_placement_lookup_failed`
>     (`session-recovery.ts:456`). `session_recovery_placement_placement` no longer exists.
>   - Tests pin `stored_resource_plan_invalid` and `lookup_failed`
>     (`apps/api/tests/unit/services/session-recovery.test.ts:~754-800`) and
>     `placement_credentials_missing` (`apps/api/tests/workers/node-lifecycle-do.test.ts:2582`,
>     `apps/api/tests/workers/scheduled-node-cleanup.test.ts:1331`).
>   - Criterion 3 decided: `recovery_attempts_exhausted` is `report`.
> - **Still open:**
>   - `archive_migration_fenced` (`retry`) is returned for any non-`root` session location,
>     archived sessions included (`session-snapshot-recovery-lifecycle.ts:146-158,361-362`), so a
>     permanent condition retries until the TTL. `archive_migration_in_progress` and
>     `session_archived` are in the table, but nothing produces them.
>   - Producer tests: nothing references `placement_unsatisfiable` (add one per
>     `PlacementResolutionError` kind: `invalid-location`, `invalid-credential-attribution`,
>     `invalid-resource-requirements`), and no producer test pins a dead-lettered deletion.
>   - Remove the `session_recovery_placement_transient` table entry; nothing produces it.
> - **Moot/dropped:** distinct names for the deletion-fence causes (dead-lettered deletion, legacy
>   `deleted` row without proof). It was decided to keep them `retry`: node termination proof can
>   still release them, the 1 h delivery TTL bounds them, and TTL expiry is now visible
>   (`tasks/archive/2026-09-25-durable-wakes-must-wake.md`, research finding 4).

## Problem

`isTransientSessionRecoveryRefusal` (`apps/api/src/services/session-recovery-refusals.ts`) lets
durable prompt delivery and the workspace eviction callback retry a wake refused for a reason that
usually clears: `workspace_deletion_unconfirmed`, `session_recovery_placement_placement`,
`session_recovery_placement_transient`. Some permanent causes share those names today:

- a dead-lettered workspace deletion keeps `getWorkspaceDeletionAttemptState().pending` true, and a
  legacy `deleted` row without proof also refuses as unconfirmed (`replacement-deletion-fence.ts`);
- a malformed stored resource plan returns `session_recovery_placement_placement`;
- deterministic `PlacementResolutionError`s (`invalid-location`, `invalid-credential-attribution`,
  `invalid-resource-requirements`) are swallowed by the generic catch as
  `session_recovery_placement_transient` (`session-recovery.ts`, `ensureSessionRecovery`).

Those retry until the caller's bound (a delivery's one-hour TTL, about 49 recovery checks) instead
of failing at once. They refuse before any claim, so no task, runtime or wake attempt is spent, and
the UI shows neither outcome.

## Context

Review of the delivery-retry fix on `sam/preserve-failed-tasks-work-fn8ba7` (2026-09-25), MEDIUM,
deferred: the split belongs where the reasons are produced (`session-recovery.ts`, the deletion
fence), which a parallel wake-placement change owns.

## Acceptance Criteria

- [ ] Permanent causes return distinct reasons at the producer; the shared list names only causes
      that clear on their own.
- [ ] Producer tests pin each reason to its classification, including a dead-lettered deletion and
      each `PlacementResolutionError` kind.
- [ ] Decide whether `recovery_attempts_exhausted` (released by a 15-minute decay) belongs in the
      list for both callers.
