# Give permanent session-recovery refusals their own names

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
