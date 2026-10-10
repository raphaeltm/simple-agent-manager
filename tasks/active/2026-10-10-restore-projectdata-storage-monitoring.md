# Restore ProjectData storage monitoring and alert when an archive breaker opens

SAM task `01M4JRV04N5GW2Q7QVF3G225TR` (reliability wave `reliability-wave-1010`, agent C).
Idea `01M4JMZVVMGRKMNC0GBV3CQN8E`. Coordinator task `01M4JK3X7BART9SDKJ3KGCDE0Q`.

## Problem

1. **Storage monitoring is silent on the SAM root ProjectData DO.** Since #2269 went live
   (2026-10-08 18:02Z) the root object (project `01KHRJGANBBWGDY1NZ0KVF0D4J`) has written no
   hourly `project_data_storage_telemetry_history` row from the measurement, every
   `project_data.storage_alarm.completed` reports `measured:false`, and the hourly critical
   operator alert stopped. The object is at 9.02 GB (90.2% of the 10 GB cap, `critical`).
2. **An archive circuit breaker that opens tells nobody.** `markFailed` poisons a migration after
   `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS` attempts and `poisonProjectDataArchiveMigration`
   opens the project-wide breaker. Only an operator closes it. Poisoning only bumps
   `stats.poisoned`; `notifyFailedSweeps` fires only for sweeps that throw. The breaker stayed
   open for five days from 09-27 and re-opened on 10-06 while storage climbed toward the cap.

## Research Findings

### Measurement clock (rule 53 / rule 74 class)

- `shouldMeasureProjectDataStorage` (`storage-safety.ts`) measures only when
  `now - storageSafetyLastMeasuredAt >= PROJECT_DATA_STORAGE_MEASURE_INTERVAL_MS`.
  `computeStorageSafetyAlarmTime` (`storage-safety-alarm-time.ts`) schedules the next measurement
  from the same key.
- `measureAndPersistProjectDataStorage` is the only path that appends the hourly history row
  *and* evaluates threshold alerts. But four other writers also stamp the key:
  - `persistCleanupHealthTelemetryAndAlerts` (`storage-alarm.ts`), on every tick where any
    cleanup step returned a result;
  - `recordEventLogCleanupTelemetry` (`event-log-cleanup.ts`), when rows were deleted or it erred;
  - `recordToolPayloadCleanupTelemetry` (`tool-payload-cleanup.ts`), when rows were stripped or it erred;
  - `runProjectDataStorageEmergencyPurgeCore` (`storage-emergency-purge.ts`), on every purge.
- **Production evidence (Workers Observability, 2026-10-10 ~11:30Z):** the root alarm completes
  roughly every minute; every ~5 minutes grouped FTS cleanup returns `row_budget`
  (`sessionsExamined: 2`, `rowsExamined: 0`, cursor advancing over empty sessions), which makes
  `cleanupHealth: 'running'` and re-stamps the key through `persistCleanupHealthTelemetryAndAlerts`.
  `PROJECT_DATA_GROUPED_FTS_CLEANUP_RECHECK_MS=300000` (5 min) is shorter than the 1 h measure
  interval, so the measurement never comes due. Before #2269 the grouped step threw
  `SQLITE_NOMEM` every run, so cleanup health never ran and the measurement still happened hourly.
  Event-log cleanup is disabled in production (`PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED=false`
  GitHub Environment override), so the cleanup-health writer is the live culprit; the event-log,
  tool-payload and emergency-purge writers are the same class and must go too.
- The #2269 production acceptance note already observed "existing cleanup-health passes refresh
  the measurement timestamp, so a separate hourly measured:true alarm was not observed" and read
  it as healthy.
- Third reader: `hasRecentOverloadSignal` (`grouped-fts-cleanup.ts`) uses the measurement clock as
  the *age of `storageSafetyLastError`*. That is a proxy for the error's own timestamp. Removing the
  cleanup writes would silently change its behaviour, so errors must carry their own timestamp.
  `storageSafetyLastError` has ~12 writers (alarm step failures, cleanup failures, telemetry and
  alert failures, weak reclaim, target-unreachable) and one clearer (`persistCleanupHealthTelemetryAndAlerts`).
- `storageSafetyLastStatus` has no readers; cleanup writers may keep updating it.

### Alert dedupe

- `maybePersistProjectDataStorageAlert` dedupes on one do_meta slot
  (`storageSafetyLastAlertAt/Status/Reason`) within `PROJECT_DATA_STORAGE_ALERT_INTERVAL_MS` (6 h).
- Production `platform_errors`: 2026-09-10..09-19 root alerts were exactly 6-hourly (dedupe works
  when the writes commit). From 10-04 20:13Z (NOMEM) they were hourly: the failing grouped step
  rolled back the dedupe markers written earlier in the same implicit transaction. #2269 fixed this
  with per-step `sync()` and pinned it with `commits alert dedupe before a failing SQLite transaction`.
  Restoring the measurement must not bring hourly rows back.
- Threshold alerts (`threshold_exceeded`) and cleanup alerts (`cleanup_target_unreachable`) share
  that single slot, so when both conditions hold each one resets the other's throttle (ping-pong:
  two alerts per measurement hour). Not observed in production yet (no target-unreachable alert
  ever), but reachable on the root object once its cleanup candidates are exhausted, and only once
  the measurement runs again.

### Archive breaker

- Breaker writers: `poisonProjectDataArchiveMigration` (automatic, via `markFailed` in the sweep and
  the manual canary), `freezeProjectDataArchiveMigration` (`frozen`), and the operator controls
  `setProjectDataArchiveCircuitBreaker` / `freezeProjectDataArchiveProject`. Only poisoning opens a
  breaker without a human.
- The poison upsert keeps `opened_at = COALESCE(existing.opened_at, now)`. Production has two
  `closed` breakers with a stale non-null `opened_at` (closed via raw SQL on 09-18), so `opened_at`
  is not a reliable per-opening identity. The closed→open transition must be detected from the
  pre-upsert `state`, read in the same D1 batch (one transaction, serialized writers).
- Existing superadmin alert path: `scheduled/failed-sweep-notifications.ts` (real superadmins
  excluding the sentinel, `sendNotificationOnce` per user with a per-user DO dedupe claim,
  notification type `cron_failure` = "Operational Failure", high urgency) plus `persistError`
  rows in `/admin/errors`. The breaker controls live at `/admin/storage`.
- Opening semantics are out of scope: no change to when or how a breaker opens.

### Files and constraints

- `project-data-archive-sharding.ts` is 4,182 lines with a FILE SIZE EXCEPTION; new logic goes in
  a new module. `storage-safety.ts` is 725 lines: do not grow it.
- No new `[vars]` in `apps/api/wrangler.toml` (production is near the text-binding guard).
- `project-data/index.ts` is shared with agent B; this plan does not touch it.

## Implementation Checklist

### A. Measurement clock belongs to the measurement
- [x] Document in `storage-safety-meta.ts` that `storageSafetyLastMeasuredAt` is written only by the full measurement and schedules it
- [x] Remove the measurement-clock write from `persistCleanupHealthTelemetryAndAlerts` (`storage-alarm.ts`)
- [x] Remove it from `recordEventLogCleanupTelemetry` (`event-log-cleanup.ts`)
- [x] Remove it from `recordToolPayloadCleanupTelemetry` (`tool-payload-cleanup.ts`)
- [x] Remove it from `runProjectDataStorageEmergencyPurgeCore` (`storage-emergency-purge.ts`)

### B. Errors carry their own timestamp
- [x] Add `recordStorageSafetyError` / `clearStorageSafetyError` / error-time reader to `storage-safety-meta.ts`
- [x] Route every `storageSafetyLastError` write and the one clear through the helpers
- [x] `hasRecentOverloadSignal` reads the error's own timestamp; a pre-upgrade error with no timestamp backs off once (bounded), never forever
- [x] Drop the duplicated local `storageSafetyLastError` constant in `grouped-fts-cleanup.ts`

### C. Alert dedupe stays sane
- [x] Workers test: hourly measurements with cleanup every tick produce alerts at the alert interval, not hourly
- [x] Workers test: threshold and target-unreachable alerts do not reset each other's throttle (red first)
- [x] Per-reason dedupe slots with the legacy single slot honoured for its own reason

### D. Archive breaker alert
- [x] Extract the superadmin fan-out from `notifyFailedSweeps` into a shared helper (no behaviour change for failed sweeps)
- [x] New module `scheduled/project-data-archive-breaker-alerts.ts`: one `persistError` row + one `cron_failure` notification per superadmin, linking `/admin/storage`; never throws
- [x] `poisonProjectDataArchiveMigration` reads the pre-upsert breaker state in its D1 batch and alerts only on closed/absent → open

### E. Tests
- [x] Workers alarm test, production signature: grouped FTS cursor advancing every tick; real `alarm()`; fake clock; asserts the hourly measurement runs, appends a history row and evaluates alerts
- [x] Workers alarm test, task signature: event-log cleanup deleting rows every tick
- [x] Discrimination: restore the cleanup-health re-stamp once (and the event-log re-stamp once) and record which tests go red
- [x] Workers tests for the overload breaker: fresh error trips, stale error does not, legacy error backs off exactly once
- [x] Unit test on a real SQL engine (better-sqlite3 D1): a migration poisoned through the real sweep opens the breaker and sends exactly one alert; further poisonings/sweeps while open send none; control: a below-threshold failure (breaker stays closed) sends none; a re-opening after an operator close alerts again
- [x] Unit test: `notifyFailedSweeps` behaviour unchanged after the extraction (existing suite stays green)

### F. Docs
- [x] `configuration.md`: measure interval and alert interval semantics; poison row mentions the alert
- [x] `self-hosting.mdx` storage/breaker section: superadmins are notified once per opening

## Implementation Notes

- Commit `8ec8116bb`: measurement clock, error timestamps, per-reason alert throttle (written
  before the D1 bookkeeping), tests. Commit `d7d28c74b`: breaker alert + shared operator fan-out.
- The cadence tests reproduce the incident on pre-fix code with liveness intact (storage safety
  ran on all 14 ticks and grouped cleanup returned `row_budget` on every one) while the T0+60m
  measurement never ran; the reason test saw 8 alerts in 4 hours.
- Discrimination (each restored afterwards): cleanup-health re-stamp back → grouped-cursor,
  event-log and alert-interval tests red, reason test green. Event-log re-stamp alone → only the
  event-log test red. Shared throttle slot → only the reason test red. Overload reader back on the
  measurement clock → fresh/stale/legacy tests red, alarm end-to-end test green. Breaker alert
  disabled → 5 positive unit tests red, 2 controls green; alert on every poisoning →
  repeat-while-open, concurrent and frozen tests red, and the Workers runtime test red.
- Extra Workers test (`project-data-archive-breaker-alert.test.ts`) proves the batched `SELECT`
  and the real NotificationService DO claim on Miniflare, since the unit suite runs on
  better-sqlite3 (rule 69 harness substitution).
- Docs also updated: `guides/notifications.md`, env-reference skill, `.env.example`.
- `turbo` injects an agent-guidance block into `AGENTS.md`; it is reverted, not committed.
- Review follow-ups (commit after `e4ecbed9b`): tests for the pre-upgrade shared alert slot
  (own reason throttled until the interval passes; other reason not throttled — each direction
  proven by a surgical revert), status worsening inside the interval, `breakerWasClosedBeforeOpening`
  pure cases, and a concurrent poisoning race on Miniflare D1; destructuring moved inside the alert
  function's `try`.
- Declined review suggestions (LOW, recorded in the PR): in-app `cron_failure` preference copy
  (still accurate: the breaker opens inside the scheduled archive sweep), error-text redaction
  (same superadmin audience already reads `error_message` in Admin → Storage), a cross-project
  alert cap (each opening is a distinct operator action), the pre-existing admin-measure vs alarm
  race, and frozen → open breaker state on poisoning (opening semantics are out of scope).

## Acceptance Criteria

- [x] Cleanup activity on every alarm tick no longer delays the hourly measurement (Workers test, proven discriminating)
- [x] The hourly measurement appends a telemetry history row and evaluates alerts again (same test)
- [x] Hourly measurements of a `critical` object produce one alert per alert interval, not one per hour
- [x] The grouped FTS overload back-off keys on the error's own age
- [x] A breaker opening (closed/absent → open) produces exactly one `/admin/errors` row and one superadmin notification; none while it stays open; none while it is closed
- [x] No new `wrangler.toml` vars, no D1 or DO migration
- [ ] Production: within ~1-2 h of deploy the root DO writes a new history row and storage-alarm completions show `measured:true`

## References

- Idea `01M4JMZVVMGRKMNC0GBV3CQN8E`; reliability queue idea `01M4DR7MBDD8AAVF1XMC2XYQEX`
- #2269 (`ef0e38a53`) and `tasks/archive/2026-10-08-project-data-storage-nomem.md`
- `apps/api/.claude/rules/53-scheduled-handler-isolation-and-liveness-signals.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `apps/api/.claude/rules/47-control-loop-io-budget.md` (requirements 9 and 10)
