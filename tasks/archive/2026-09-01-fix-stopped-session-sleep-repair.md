# Fix stopped ProjectData session sleep repair

## Problem

Production still has terminal active workspaces after the stable `sleep_stopping_since` fix. The remaining rows are valid restorable D1 snapshots in `available/stopping`, but repair does not transition them to `sleeping`.

Opus review identified the root cause: terminal-session reconciliation and sleep lifecycle repair share the same in-flight ceiling. Once a `stopping` snapshot crosses that ceiling, terminal-session reconciliation can stop the ProjectData chat session. Later, `runSessionSleepLifecycleRepair` calls `projectDataService.sleepSession()`, but the ProjectData DO implementation only transitions sessions from `active` to `sleeping`. For an already `stopped` session, it returns false, and repair leaves D1 stuck in `stopping`.

## Research findings

- `apps/api/src/scheduled/session-sleep-lifecycle-repair.ts`
  - Selects stale `preparing`/`stopping` rows using `sessionSleepInFlightMaxAgeMs`.
  - Calls `projectDataService.sleepSession()` before marking D1 snapshot/workspace sleeping.
  - If ProjectData sleep returns false, increments `projectDataErrors` and continues.
- `apps/api/src/durable-objects/project-data/sessions.ts`
  - `sleepSession()` updates `chat_sessions` only when `status='active'`.
- `apps/api/src/durable-objects/project-data/terminal-session-reconciliation.ts`
  - Defers while `findRestorableOrInFlightSleepSnapshot()` returns a row.
  - Once the same in-flight ceiling expires, it can call `stopSession()`.
- `apps/api/src/services/project-data.ts`
  - Already exports `getSession()`, which can be used to distinguish already `stopped`/`sleeping` from missing/unknown session state.

## Checklist

- [x] Add ProjectData status check in stale sleep repair when `sleepSession()` returns false.
- [x] Allow repair to continue when ProjectData session is already `sleeping` or `stopped`.
- [x] Preserve retry/error behavior for missing sessions or unsupported statuses.
- [x] Add unit regression for stale D1 `stopping` + ProjectData `stopped`.
- [x] Add unit regression for stale D1 `stopping` + ProjectData already `sleeping`.
- [x] Run focused test suite and relevant quality checks.

## Acceptance criteria

- A stale post-capture `stopping` snapshot repairs even if ProjectData session was already stopped by terminal-session reconciliation.
- A stale post-capture `stopping` snapshot repairs idempotently if ProjectData session is already sleeping.
- A false `sleepSession()` with missing/unknown ProjectData session still does not mark D1 sleeping.
- Existing repair behavior remains unchanged when ProjectData sleep succeeds.
