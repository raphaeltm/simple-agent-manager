# ProjectData archive drain: fill the tick, stop false refusals, resumable large sessions

SAM task `01M784YVJMQN6Z49XJRTJDVKPV` (parent `01M77TZWBDJHQ3Z87V2NYZMFK1`). Design: idea
`01M75F3XNHX93FRAYM8TM6DVPK`. Branch base: `main` (agreed with modularization coordinator
`01M77BJHHNW5714E98DEEMBCZA`; PR body must list new files, test imports of ProjectData internals,
and any DO/D1 migrations, and the PR URL goes to the coordinator at open and merge).

## Problem

The SAM root ProjectData DO is at 9.08 GB of a 10e9 limit (2026-11-12 12:20Z alert), growing
~250 MB/day. Ingest is ~85k messages/day; the archive drain moves ~45k/day.

## Production evidence (read-only, 2026-11-12 17:10Z)

- Journal: 3,632 `published`, 187 `frozen`, nothing in flight. Cadence row: run_count 3876,
  last tick 17:06:19Z to 17:06:30Z (11.2 s), status succeeded.
- 70 publishes in 24 h = exactly one per 18-min tick; 84,629 messages; avg 1,209, max 9,325.
  The last 6 h were mostly ~441-message sessions.
- `project_data_archive_candidate_migrated` phase timings (441-860 msgs): total 7.8-13.7 s;
  prepare 0.45-0.66 s, copy 4.5-9.3 s (3-4 chunks, ~1.5-2.3 s/chunk), seal 0.38-0.59 s,
  manifest 0.87-1.3 s, finalize 1.57-2.2 s (source delete ~1.0-1.7 s). A small session costs
  ~8-10 s of fixed work, i.e. the 10 s `WALL_TIME_MS` admits exactly one per tick.
- Tick 16:46Z: reserved 16,514 writes for `a26bc025` (~8k msgs), refused 3 s later
  `active_session_state`, reservation not released; then published an 860-msg session.
  Confirms: a refused candidate consumes the cumulative message budget AND keeps its write
  reservation, and only one useful session fits in 10 s.
- Eligible root backlog (stopped/failed, root): le1k 2,864 sessions / 523k msgs; 1k-10k 157 /
  469k (+142 frozen / 568k); >10k 157 / 3.26M (+5 frozen). Sleeping in root: 579 / 2.44M.
- Frozen refusals: 125 `active_session_state`, 35 `unresolved_attention`, 13
  `message_comments_present`, 1 `tool_payload_cleanup_incomplete`, 13 `operator_abandoned`.
- GitHub Environment overrides: production pins only `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED`,
  `_DAILY_WRITE_BUDGET=2400000`, `_GLOBAL_SWEEP_ENABLED`, `_SHARDING_ENABLED`. Staging pins none
  of the archive vars. `WALL_TIME_MS`, `SWEEP_SESSIONS`, `SWEEP_MESSAGE_BUDGET`,
  `PRECOPY_REFUSAL_RETRY_MS` take wrangler.toml / code defaults.
- Cron: archive step already runs after every lifecycle sweep (`scheduled/handler.ts`);
  `[limits] cpu_ms = 30000`.

## Plan (staged PRs)

### PR 1: relief (fill the tick, stop false refusals, end dead sleepers)

- [x] 1a `processArchiveMigrationBatch`: drop the cumulative message packer from the journaling
      loop (per-candidate ceiling stays in SQL). A refused candidate releases its write
      reservation and does not consume a session slot.
- [x] 1a wrangler.toml: `WALL_TIME_MS` 10000 → 60000, `SWEEP_SESSIONS` 8 → 50; update comments
      and configuration docs. Throughput at the outer limit stated in PR (rule 81).
- [x] 1b `assertEligibleTerminalSource`: drop `'error'` from the activity refusal; keep
      prompting/recovering and runtime_work_state active/settling.
- [x] 1b attention refusal only while `COALESCE(expires_at, created_at)` is within the session
      grace (an unprocessed expiry cannot race the expiry alarm's `failSession`).
- [x] 1b Refusal retry window default 7 d → 1 d (refusals are now cheap: released reservation,
      no slot). Permanent, so no expiry knob is needed; document it.
- [x] 1c `expireDegradedSleepingConversations`: remove the open-task EXISTS; exclude sessions
      with queued/delegated tasks in SQL so they cannot sit at the head of the batch.
- [x] Tests: real scheduled trigger with a refused large candidate first and many small sessions
      after (several publish in one tick; reservation released); real failSession then prepare
      accepted, with prompting / fresh-marker controls; snapshot-purge trigger terminalizes a
      degraded no-fallback sleeper with a completed task; zombie (queued task) row ahead of valid
      rows does not block them.
- [ ] Staging: real scheduled ticks; measure tick wall, full `cron.completed` duration on archive
      ticks, coordinator CPU, publishes per tick; verify deployed `WALL_TIME_MS=60000`,
      `SWEEP_SESSIONS=50` and the 1-day refusal retry (rule 70); sleeper expiry on real rows.
- Not changed in PR 1, by design: `message_comments_present` stays a refusal (archiving would
  cascade-delete the comments; 13 sessions), and `tool_payload_cleanup_incomplete` clears when the
  cleanup retry succeeds (1 session). Legacy (non-compact) admission is now bounded only by wall
  time and slots; production runs compact.

### PR A: flip, publish, then reclaim (bounded finalize)

Research (2026-11-12, current main):

- Coordinator phases (`scheduled/project-data-archive-sharding.ts`): `migrateClaimedCandidate` →
  ensureSourcePrepared → ensureTargetPrepared → `copySourceChunks` → `sealTargetAndSource`
  (target `archiveTargetSeal` + source `archiveSourceMarkTargetSealed`) → `persistRecoveryManifest`
  (R2 manifest + source mark) → `finalizeSourceAndPublish` (`archiveSourceFinalizeDelete`, CAS
  journal → source_deleted, then `publishSourceDeletedGap` CAS → published + `publishArchivedLocation`).
- Root `finalizeSourceDelete` (`durable-objects/project-data/archive-sharding.ts`) re-runs
  `assertEligibleTerminalSource` and the full `computeTerminalVersion` hash, then in ONE
  `transactionSync` deletes grouped FTS markers + grouped rows (paged), `tool_payload_archives`,
  `chat_messages`, and writes the `chat_sessions.archive_*` anchors + intent `source_deleted`.
- Root exact reads (`archiveSourceReadMessages`, `archiveSourceReadMessageCount`,
  `assertSourceExactReadAvailable`) FAIL CLOSED while any source intent is active
  (`isActiveSourceIntentState` = anything but `rehome_exported`). Routing
  (`services/project-data-archive-routing.ts` `resolveExactReadOwner`) also refuses `migrating` /
  `frozen` locations. So today a session is unreadable for the whole migration; with multi-tick
  copies (PR B) that window must become readable on root until the flip.
- `recoverCrashGaps` republishes `source_deleted`/`published` journals whose location is not yet
  `archive_shard`; journal transitions table `ARCHIVE_JOURNAL_TRANSITIONS` in routing service
  already allows `source_deleted -> source_deleted`.

- [ ] Flip transaction keeps anchors, drops whole-session deletes; `source_deleted` means
      "flipped + published, reclaim outstanding"; bounded reclaim RPC pages; copy-back requires
      `published`; root read fence; search dedupe verified; maintenance audit (item 7).

Measurements (2026-11-12):
- Production `candidate_migrated`, 4.4k-9k msgs: prepare 0.38-0.78 s (includes the root terminal
  hash), copy 15.8-23.5 s (11-20 chunks, ~1.1 s/chunk), seal 0.23-0.59 s, manifest 0.47-1.24 s,
  finalize 3.7-9.4 s of which source delete 0.7-5.5 s. Total ~3.5 ms/msg.
- Local workerd, 20k production-shaped msgs: `computeTerminalVersion` 1.13 s (0.056 ms/msg);
  `DELETE chat_messages` 0.25 s. Production per-row cost is several times higher (9 GB object).
- Size distribution of sessions >10k (prod D1): 249 at 10-20k, 78 at 20-50k, 11 at 50-100k,
  max exactly 100,000 = `DEFAULT_MAX_MESSAGES_PER_SESSION`. Outer probable limit: 100k msgs.
- Extrapolated at 100k: root hash ~8 s per pass (bounded by the message cap; memory paged), copy
  ~250-450 s (must span ticks), source delete up to ~60 s in one root transaction (must page).
  Compact seal is O(chunks) and cheap.

PR A design (decided):
- Flip = `finalizeSourceDelete` minus the deletes: same proof checks and terminal-version
  recompute, writes anchors + intent `source_deleted` in one transaction. Journal then goes to
  `published` exactly as today, so journal state meanings do not change (old code in a mixed
  deploy sees the same states).
- Reclaim is driven by the ROOT intent, not the journal: root RPC lists `source_deleted`
  intents that still own rows (EXISTS on chat_messages / grouped / tool_payload_archives);
  root RPC deletes one bounded page (messages first so materialization cannot regenerate,
  then grouped + FTS markers, then tool payload archives). Coordinator reclaims after each flip
  and in a reclaim pass at the start of each tick, under the tick deadline.
- Root exact reads for a `source_deleted` intent already fail closed; routing already points
  at the shard. Copy-back must refuse while reclaim is outstanding.
- Audit (item 7): tool-payload cleanup, grouped FTS cleanup, materialization, storage
  measurement, breaker alerts, root search dedupe.

PR A progress (branch `sam/archive-flip-reclaim`, worktree `/workspaces/sam-archive-pra`, commit
665c77c79, based on PR 1 head 348695314 — rebase onto main after #2700 merges):
- [x] Flip without deletes (`finalizeSourceDelete`), `reclaimArchiveSourcePage`,
      `listArchiveSourceReclaimPending`, RPCs `archiveSourceReclaimPage` /
      `archiveSourceListReclaimPending`, post-flip reclaim + tick-start `reclaimPendingSources`.
- [x] Comment guard checks the `source_deleted` intent before the row (comments.ts).
- [x] Copy-back fence: `do_meta` key `archive_copy_back_in_progress:<session>` set by the first
      restore chunk, cleared by `markSourceCopyBackRestored`; reclaim refuses / listing skips.
- [x] Tests `tests/workers/project-data-archive-flip-reclaim.test.ts` (4) + updated sharding,
      compact, throughput suites; test-double failure injection in `support/expected-error-doubles.ts`.
      Discriminating: comment guard, copy-back fence, pending pass each redden one test.
- [ ] Remaining audit (item 7): tool-payload cleanup / materialization / grouped-FTS cleanup on
      leftover rows (convergent by design: messages deleted first), breaker alerts, storage
      measurement; docs (configuration.md archive section, self-hosting copy-back notes).
- [ ] PR body, reviews, staging (ask modularization coordinator before deploying).

### PR B: resumable cursor for every size

- [ ] Deadline threaded into chunk loop/phase boundaries/reclaim; yield releases lease and resets
      attempts on progress; reserve writes once; estimator cap; flip-or-unwind; remove 10k gate.
- [ ] Seal/verification bounded and resumable (item 6); measure memory/CPU/lease.

## Compact-path staging checks (reusable; run after setting staging PROJECT_DATA_ARCHIVE_COMPACT_ENABLED=true and deploying)

1. Bindings: `GET /accounts/<acct>/workers/scripts/sam-api-staging/settings` shows
   `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED=true`, `_WALL_TIME_MS=60000`, `_SWEEP_SESSIONS=50`.
2. Wait for a tick: `project_data_archive_global_sweep_cadence.last_started_at` must be after the
   API deploy time; `last_status='succeeded'`; the duration is roughly the wall time when work exists.
3. D1: `SELECT state, storage_format, error_code, count(*) FROM project_data_archive_migrations
   WHERE updated_at > now-1h GROUP BY 1,2,3`. Expect `published` rows with
   `storage_format='r2-gzip-v1'`, and several per tick (not exactly one).
4. Logs `project_data_archive_candidate_migrated`: one per publish, with `phaseDurationsMs`.
   `project_data_archive_write_budget_reserved`: one per candidate.
5. Refusal releases its reservation: when `project_data_archive_candidate_refused` appears,
   `project_data_archive_unused_reservations` gains a receipt whose `estimated_writes` equals that
   candidate's reserved estimate.
6. Restore: delete the variable, redeploy, confirm the binding is gone or false.

Staging result 2026-11-12 22:20Z (578d1fdeb): 7 compact publishes in a 61.5 s tick, 1 refusal with
a 1,284-write receipt, ProjectData DO p99 unchanged.

## Notes

- 2026-11-12 23:15Z: #2700 approved by the coordinator at f07300c34. On that head every
  required check passed (20 pass, 10 skipped) except Specialist Review Evidence. CI run
  43323575946 was created at 22:50:25Z, 56 s before the `needs-human-review` label was
  removed (22:51:21Z), and the check takes the union of payload and live labels, so it cannot
  pass on a rerun. This task-file-only commit provides a fresh `pull_request` event.

- PR 1 discrimination (2026-11-12, `tests/workers/project-data-archive-drain-relief.test.ts`):
  reverting `scheduled/project-data-archive-sharding.ts` reddens exactly "publishes the smaller
  sessions behind a refused largest candidate" and "releases the write reservation"; reverting
  `durable-objects/project-data/archive-sharding.ts` reddens exactly the failSession case and the
  two stale-marker cases (controls stay green); reverting `services/session-expiry.ts` reddens
  exactly the completed-task sleeper and the queued-zombie cases. Review follow-ups: the slot case
  ("a refused candidate does not take one of the tick's session slots") goes red when `journaled++`
  is unconditional; the expiry-race marker control goes red against the previous
  `expires_at > now OR ...` predicate. New allowance test
  (`write-budget-shipped-factor.test.ts`) goes red at a 1,900,000 allowance (694 < 720).
- Staging found (2026-11-12 18:30Z): 8 expired degraded sleepers whose sessions were already
  archived failed every purge sweep (`stopSession` fenced by `archive_shard`). Fixed:
  `expireSleepingConversation` skips the stop for a non-root location. Test "expires the snapshot of
  a sleeper whose transcript the archive already moved" goes red without the fix (with routing on).
- PR 1 test imports of ProjectData internals: none beyond existing public RPCs on the DO stub.
  New file: `apps/api/tests/workers/project-data-archive-drain-relief.test.ts`. No DO or D1
  migrations.

- 2026-11-12 17:06Z workspace was recycled while paused; untracked `.do-state.md` was lost.
  Keep durable state here and push.
