# ProjectData storage safety follow-ups (2026-10-03)

## Problem

The SAM project's root ProjectData Durable Object sat at Cloudflare's hard 10 GiB per-object cap
(10,737,418,240 B) on 2026-10-02 09:34Z-15:38Z, and every SAM write failed. Verified in production
(read-only) on 2026-10-03 08:12Z, it is 10,186,911,744 B, about 550 MB under the cap.

The chain that led there:

1. One archive migration was poisoned (`attempts_exhausted:CompactArchiveTimeoutError`) on 09-27
   16:47Z. That opened the project's archive circuit breaker and stopped the whole project's drain
   for five days. The poisoned session itself was already quarantined (location `frozen`), so the
   breaker only stopped the project's other sessions.
2. Nothing told an operator. Opening a breaker logs nothing. Storage "alerts" are a log line plus a
   `platform_errors` row, and the status scale tops out at `degraded` (0.95 x 10^10), so 100% and
   107% of the configured limit look the same.
3. The DO grew ~205 MB/day to the cap. At the cap the archive drain cannot run, because it writes
   bookkeeping rows before freeing anything, and its storage-full failures count toward poisoning.
   So the cure re-opens the breaker; this happened in production on 09-03 at 09:51Z.
4. The only automatic reclaimer besides the drain, the alarm grouped-FTS cleanup, refuses at or
   above 0.98 x 10^10 (`wall_unsafe`). That is 91% of the real cap, and it has refused for SAM since
   ~09-03. `wall_unsafe` also hides the `target_unreachable` alert.
5. Relief came from #2215's manual superadmin wall-recovery route (~464 MB). That route has no
   admin UI control, against policy 2b97aefc (phone-usable admin buttons).
6. On 10-03 the nightly billing agent slowed the drain 3x (#2216) for a cost spike the drain did not
   cause.

## Scope (Raphaël, 2026-10-03: "Try to do 1-5", Astra reviews plans and executed work)

1. Revert #2216. PR on `sam/restore-archive-sweep-cadence`.
2. Rewrite the Daily Billing Alert trigger prompt. Done outside the repo on 2026-10-03 11:55Z:
   - $30/mo projected-spend floor
   - run-to-run log in library `/billing-monitor/daily-log.md`
   - root cause first
   - never throttle storage protection
3. Breaker policy, so one poisoned session cannot stop a project's drain, plus superadmin alerts for
   open breakers and for DOs near the real cap.
4. Admin -> Storage control for the #2215 grouped-FTS wall recovery.
5. Let the alarm grouped-FTS cleanup run safely above the unsafe ratio, up to the real cap.

## Research findings (code citations as of origin/main a04bb62d1)

### Breaker (item 3)

- Production breaker writers: `poisonProjectDataArchiveMigration`
  (`scheduled/project-data-archive-sharding.ts:3226-3273`), reached only through `markFailed`
  (3144-3175) when `attempt_count >= PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS` (default 3). The
  reason stored is `attempts_exhausted:${error.name}`. Nothing is logged.
- Poisoning already quarantines the session:
  - the location becomes `frozen` (3255-3261)
  - `selectCandidates` requires `location_state='root'` (1363-1376)
  - `ACTIVE_RECLAIMABLE_STATES` excludes `poisoned`/`frozen` (92-101)
- Five gates require `COALESCE(breaker.state,'closed')='closed'`: 1197-1200, 1228-1233, 1363-1376,
  1416-1431 and 1653-1661.
- Poisoning ignores the error class. A storage-full failure (`isDurableObjectStorageFullError`,
  `services/durable-object-retry.ts:39-45,69-73`) counts toward poisoning, so a full DO poisons the
  drain that would free it.
- Abandon restores the location to `root` (3610-3617), so the same session can be journaled and
  poisoned again.
- Nothing auto-closes a breaker. Close route: `routes/admin/project-data-storage.ts:406-419`. UI:
  `apps/web/src/pages/AdminStorage.tsx:103-113,163-179,264-317`.
- `project-data-archive-sharding.ts` carries a FILE SIZE EXCEPTION comment (4182 lines).

### Alerts (item 3)

- `maybePersistProjectDataStorageAlert` (`durable-objects/project-data/storage-telemetry.ts:319-410`)
  writes a log, `platform_errors` and the `last_alert_*` columns every >=6 h. It pages no one.
- The superadmin push path already exists: `notifyFailedSweeps`
  (`scheduled/failed-sweep-notifications.ts:24-98`). It does superadmin lookup, a KV throttle, and
  `sendNotificationOnce` with type `cron_failure`, which the UI shows as "Operational Failure".
  Nothing uses it for storage or breakers.
- At the cap, `measureAndPersistProjectDataStorage` writes DO meta before the D1 telemetry upsert
  and the alert, outside any try (`storage-safety.ts:662-663`; also `storage-alarm.ts:202-207`). A
  storage-full error can therefore abort the measurement and the alert exactly when they matter.

### Wall recovery UI (item 4)

- Route `POST /api/admin/project-data/storage/:projectId/grouped-fts-wall-recovery`
  (`routes/admin/project-data-storage.ts:594-629`). Superadmin only. The schema
  (`schemas/admin.ts:46-54`) requires `reason`, `dryRun`, `maxRows`, `maxBytes`, `maxSessions` and
  takes an optional `skipSessionIds`.
- Ceilings come from env (defaults 10,000 rows / 32 MiB / 500 sessions). No GET exposes them.
- The result type exists only in the API (`grouped-fts-wall-recovery.ts:98-132`).
- A page failure returns HTTP 200 with `stopReason:'transaction_failed'`, `error` and
  `failedSessionId`. A storage-full error returns 507.
- Admin -> Storage: `apps/web/src/pages/AdminStorage.tsx` (320 lines),
  `admin-storage/ProblemMigrations.tsx` (271), API client `lib/api/admin-project-data-storage.ts`,
  query keys `lib/query-options/admin-project-data-storage.ts`.
- Tests:
  - `apps/web/tests/unit/AdminStorage.test.tsx`
  - Playwright `apps/web/tests/playwright/admin-storage-audit.spec.ts`
  - route test `apps/api/tests/unit/routes/admin-project-data-wall-recovery.test.ts`
- `routes/admin/project-data-storage.ts` is 642 lines, so it must be split before it grows (rule 18).
- The Storage-buttons docs are at `apps/www/src/content/docs/docs/guides/self-hosting.mdx:386-409`.

### Alarm grouped-FTS cleanup (item 5)

- `runProjectDataGroupedFtsCleanup` (`durable-objects/project-data/grouped-fts-cleanup.ts:277-453`)
  refuses `if (beforeBytes >= unsafeBytes)` with `wall_unsafe` (298-301).
- It deletes the FTS entry first, then the row, per row and with no transaction (193-259).
- It skips sessions over 1000 rows / 4 MiB (`oversized_skip`), so the largest sessions are never
  pruned.
- Its candidate query lacks the archive source-intent/target exclusion. Pruning mid-migration
  therefore fails the migration with `terminal_version_changed`.
- Rationale for refusing near the wall:
  - `tasks/archive/2026-08-31-projectdata-pre-wall-storage-relief.md:50-51,114-116`
  - `grouped-fts-wall-recovery.ts:23-26`: an FTS5 delete writes a segment about as large as the
    postings it cancels.
- #2215's engine (`grouped-fts-wall-recovery.ts`, `grouped-fts-wall-recovery-prune.ts:98-140`):
  - largest first
  - excludes sessions with an archive intent or target
  - pages through big sessions
  - one `transactionSync` per page (rows, prune mark, FTS deletes), rolled back on failure
  - only on storage-full does it fall back to rows+mark first and leave stale FTS entries
    (`ftsStaleRows`)
- Stale postings are never cleaned. Archiving does not remove them, and grouped rowids can be reused.
- Archiving rebuilds full FTS for a pruned session in the shard from raw `chat_messages`
  (`archive-sharding.ts:2493-2590`, compact 2360-2392). Pruning the root's grouped index therefore
  only degrades search until the session is archived.
- Test harness for "full":
  - `tests/workers/project-data-grouped-fts-wall-recovery.test.ts:184-230` uses a Proxy on
    `state.storage.sql` that throws `Exceeded the maximum database size.` on chosen statements.
  - "Near the wall" is simulated by shrinking `limitBytes` (`project-data-storage-safety.test.ts:273-282`).

## Plan

### Item 3a: breaker opens only for systemic failure

- In `markFailed`, a storage-full failure never poisons. The migration stays `failed`
  (`error_code` = error name), and the retry follows `PROJECT_DATA_ARCHIVE_FAILED_RETRY_DELAY_MS`.
  The condition is "this session cannot be archived"; the signal "it failed N times" diverges when
  the object itself is full (rule 74).
- In `poisonProjectDataArchiveMigration`:
  - Still poison the migration and freeze the session location (quarantine).
  - Open the project breaker only when the number of distinct sessions poisoned in that project
    within `PROJECT_DATA_ARCHIVE_BREAKER_POISON_WINDOW_MS` (default 86,400,000) reaches
    `PROJECT_DATA_ARCHIVE_BREAKER_POISON_THRESHOLD` (default 3).
  - A threshold of 1 restores today's behaviour.
- Log `project_data_archive.migration_poisoned` (warn) and, on a real closed->open transition,
  `project_data_archive.breaker_opened` (error).
- Tests (real SQLite via `createSqliteD1`, rule 28):
  - one poison quarantines the session, the breaker stays closed, and another root session in the
    same project is still returned by the real `selectCandidates` (vertical slice)
  - the third distinct poisoned session inside the window opens the breaker
  - poisons outside the window do not count
  - the same session poisoned twice counts once
  - a storage-full failure at the attempt limit is `failed`, not `poisoned`, and the breaker stays
    closed
  - threshold=1 opens on the first poison (convergence control)
  - discrimination: delete the threshold guard and the single-poison test goes red

### Item 3b: superadmin alerts (new isolated cron step)

- Extract `notifySuperadminsOnce` from `notifyFailedSweeps` (superadmin lookup, KV throttle,
  `sendNotificationOnce`). `notifyFailedSweeps` keeps its behaviour and its tests.
- New `scheduled/project-data-storage-alerts.ts`, wired into the scheduled handler as an isolated
  step (rule 53). It sends:
  - `open` breaker: high urgency, "Archive drain stopped for <project>", reason, opened time,
    `/admin/storage`.
  - `frozen` breaker: medium urgency (a deliberate operator state, but a forgotten one does the same
    damage).
  - `project_data_storage_telemetry.database_size_bytes >= PROJECT_DATA_STORAGE_HARD_CAP_BYTES`
    (default 10,737,418,240) `x PROJECT_DATA_STORAGE_WALL_ALERT_RATIO` (default 0.95): high urgency,
    "<project> storage at X GB of the 10 GiB hard cap".
- Throttle per alert key with `PROJECT_DATA_STORAGE_ALERT_NOTIFICATION_THROTTLE_MS` (default
  21,600,000). The key includes project id + breaker `opened_at`, so a re-opened breaker alerts again.
- Type `cron_failure` ("Operational Failure"): no new notification type, schema or settings change.
- Tests (real SQLite D1 + KV/notification fakes):
  - each alert fires once per throttle window
  - closed breakers and sizes below the threshold send nothing, with a positive control in the
    same test (rule 62)
  - a second breaker opening after a close re-alerts
  - a failing superadmin lookup or notification is isolated
- Rule 47 I/O budget: the step costs 2 D1 reads + 1 superadmin read + per-alert KV get/put + per-user
  notification. That is well under 30 per tick at the current scale (1 breaker, 1 near-cap project).

### Item 3c: measurement survives a full object

- In `measureAndPersistProjectDataStorage` and the storage-alarm cleanup-health path:
  - upsert D1 telemetry and raise the alert before the DO meta writes
  - wrap the meta writes so a storage-full error is logged and does not abort the D1 telemetry or
    the alert
- Test (Workers): the storage-full Proxy on meta writes still updates the D1 telemetry row and
  still persists the alert.

### Item 4: Admin -> Storage wall-recovery control

1. Pure-move commit first. Split `routes/admin/project-data-storage.ts` into
   `routes/admin/project-data-storage/` with:
   - `index.ts`: barrel, same export, mounted order preserved
   - `telemetry.ts`
   - `archive-sharding.ts`
   - `relief.ts`
   Existing route tests must pass unchanged.
2. Add superadmin `GET /api/admin/project-data/storage/grouped-fts-wall-recovery/config`. It returns
   `{ ceilings: {maxRows,maxBytes,maxSessions}, defaults: {maxRows,maxBytes,maxSessions} }`.
   - Defaults come from new `PROJECT_DATA_GROUPED_FTS_WALL_RECOVERY_DEFAULT_MAX_{ROWS,BYTES,SESSIONS}`
     (500 / 4 MiB / 1, the first real call from the #2215 Cloudflare review), clamped to the
     ceilings.
   - It must be registered before any 2-segment GET `/:projectId/...` route.
3. Move the request/result/config types to `packages/shared/src/types/admin.ts`. The API imports
   them.
4. Web: new `apps/web/src/pages/admin-storage/WallRecovery.tsx`:
   - a "Recover space" button on each telemetry card
   - the dialog has a reason (required, max 500), a dry-run checkbox (default on), and budgets
     prefilled from `config.defaults` and capped at the ceilings (bytes shown in MiB)
   - the result panel shows sizes before/after/delta, sessions, rows, FTS entries deleted, stale
     FTS rows, and the stop reason (label map at module scope)
   - on `transaction_failed`, show `error` + `failedSessionId` with "Skip this session and retry"
   - after a real run, invalidate the storage queries and say the telemetry refreshes at the next
     measurement
   - TanStack Query for the config, `useMutation` for the run
5. Tests:
   - route tests: superadmin-only, defaults clamped to ceilings
   - web unit tests: prefill, exact request body, result rendering, 507, skip-and-retry
   - Playwright audit at 375x667 and 1280x800 with normal/long/error/many data, screenshots posted
     to the PR
6. Docs: `self-hosting.mdx` Storage section, `configuration.md`, env-reference.

### Item 5: near-wall mode for the alarm grouped-FTS cleanup

- When `beforeBytes >= unsafeBytes`, the alarm stops returning `wall_unsafe`. Instead it runs
  #2215's engine in an alarm mode:
  - same candidate query: terminal, aged, no archive intent/target, largest first, pages through
    big sessions
  - each page is one atomic `transactionSync` (rows + prune mark + FTS deletes)
  - **no stale-FTS fallback**: on storage-full the page rolls back and the run stops with a new
    `near_wall_storage_full` reason, so the alarm never leaves stale postings
- Per-tick budgets reuse the alarm's batch config (2 sessions / 1000 rows / 4 MiB). The existing
  weak-reclaim stop applies: if a run does not shrink the object, it stops and backs off.
- Exhausted candidates now report `candidates_exhausted`, so the `target_unreachable` alert can fire
  again.
- New `PROJECT_DATA_GROUPED_FTS_CLEANUP_NEAR_WALL_ENABLED`, default `true`. `false` restores
  `wall_unsafe`.
- The below-ratio path is unchanged.
- Tests (Workers):
  - near-wall prunes the largest eligible session and the FTS `integrity-check` passes
  - archive-intent sessions are untouched
  - storage-full on an FTS delete rolls the whole page back, leaves no stale entry, and stops with
    the new reason
  - flag off gives `wall_unsafe` (control)
  - the below-ratio path is unchanged (control)
- Docs: `configuration.md` and env-reference. Also fix SKILL.md:293, which still says
  "production-disabled" while wrangler ships `true`.

## Acceptance criteria

- [ ] AC1: production runs `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_INTERVAL_MS=1080000`, verified via
      D1 `project_data_archive_global_sweep_cadence` after deploy.
- [ ] AC2: the billing trigger prompt has the $30 floor, the run log, spike/sustained/runaway
      classification and the protected-mechanism rule. Astra reviewed it.
- [ ] AC3: a single poisoned session never opens a project breaker, and its project's other sessions
      keep draining (real-selector test).
- [ ] AC4: a storage-full archive failure never poisons a migration.
- [ ] AC5: superadmins get a push/in-app "Operational Failure" notification within one cron tick
      when a breaker is open/frozen or a DO is >= 95% of the hard cap. It repeats at most once per
      throttle window.
- [ ] AC6: a storage-full DO meta write does not stop D1 telemetry or the alert.
- [ ] AC7: Admin -> Storage can dry-run and run grouped-FTS wall recovery from a phone viewport,
      with server-provided defaults and ceilings. Verified on staging.
- [ ] AC8: the alarm cleanup prunes near the wall atomically, never leaves stale FTS postings, and
      skips archive-intent sessions.
- [ ] AC9: docs and env-reference are in sync. The task-completion validator passes. Astra reviewed
      the executed work.

## Checklist

- [x] Item 1 revert branch pushed (`sam/restore-archive-sweep-cadence`, f02fc721c), local
      task-completion check PASS
- [ ] Item 1 PR, CI, merge, deploy, D1 verification
- [x] Item 2 trigger prompt applied, seed log uploaded (library fileId 01M40SXDT3X87T7SW1JQ9B5D49)
- [ ] Astra round 1 (items 1+2) addressed
- [ ] Astra round 2 (this plan) addressed
- [ ] 3a breaker policy + tests
- [ ] 3b alerts step + tests
- [ ] 3c measurement robustness + test
- [ ] 4 route split (pure move), GET config, shared types, web control, tests, Playwright, docs
- [ ] 5 near-wall mode + tests + docs
- [ ] Local specialist reviews, staging verification, Astra round 3, PRs, CodeRabbit, merges, deploy
      monitoring

## Notes

- Rule 70: none of the new vars are pinned in the production GitHub Environment (checked
  2026-10-03). Verify the deployed values after merge anyway.
- Open question for the review: should `frozen` breakers alert at all, given a freeze is a
  deliberate operator action?
