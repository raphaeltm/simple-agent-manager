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
  at the shard. Copy-back (as shipped): the coordinator drains reclaim first, the root refuses a
  first restore chunk while leftovers remain, and a `do_meta` fence keeps reclaim off rows a
  copy-back is restoring. This replaces the earlier "copy-back requires `published`" idea: the
  journal reaches `published` at the flip, so that gate would not have protected anything.
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
- [x] Tests `tests/workers/project-data-archive-flip-reclaim.test.ts` (7) + updated sharding,
      compact, throughput suites; test-double failure injection in `support/expected-error-doubles.ts`.
      Discriminating: comment guard, copy-back fence, pending pass each redden one test.
- Audit note (2026-11-12 22:18Z): tool-payload cleanup (`tool-payload-cleanup-candidates.ts`) scans
  `chat_messages` by rowid project-wide, so during a reclaim window it can strip a leftover row's
  payload and write an R2 object no shard row references. Bounded: leftovers exist only between an
  interrupted reclaim and the next tick's pending pass (≤ one 18-min cadence), and cleanup runs
  only under an approved plan. Not changed: that scan feeds manifest-checked emergency plans
  (rule 69), where altering candidate selection changes approved row counts.
- Reclaim throughput (rule 81): pages of `PROJECT_DATA_ARCHIVE_CHUNK_ROWS` (500) rows, clamped at
  2,000. Production delete cost was 0.7-5.5 s per 4.4k-9k-message session (~0.1-0.6 ms/row), so a
  100k-message session is ~10-60 s of reclaim, run as ~200 pages of 0.05-0.3 s each across at most
  two 60 s ticks (post-flip, then the next tick's pending pass).
- Deferred to PR B (tracked here): a deterministic test of the deadline exit in
  `reclaimFlippedSession` / `reclaimPendingSources` (the tick checks the deadline before
  journaling, so a tiny wall time cannot flip first); an operator signal for reclaim that stays
  pending across ticks (today: `reclaimPending` in sweep stats + per-session warn logs); reclaimed
  bytes in the reclaim log (today only the intent's `source_database_size_after`).
- [ ] Remaining audit (item 7): tool-payload cleanup / materialization / grouped-FTS cleanup on
      leftover rows (convergent by design: messages deleted first), breaker alerts, storage
      measurement; docs (configuration.md archive section, self-hosting copy-back notes).
- [ ] PR body, reviews, staging (ask modularization coordinator before deploying).

### PR B: resumable cursor for every size

Branch `sam/archive-resumable-cursor` (stacked on PR A), owner task `01M795CM7DAPCSF4E94AJK09CP`.

Research findings (2026-11-13, from the PR A head):

- Every resumed claim re-ran the root prepare (`ensureSourcePrepared`): full eligibility, write
  estimate and a FULL terminal-version hash on the root object, once per tick a migration spans.
- `reserveMigrationAttempt` re-reserved the whole write estimate on every claim of a compact
  migration that had not flipped.
- `claimMigrationLease` increments `attempt_count` per claim; poison after 3 claims regardless of
  progress, so a session needing 4+ ticks could never publish.
- The compact pre-flip `archiveTargetSeal` re-call ran `readValidatedSeal`, which re-read every R2
  chunk of the session in ONE RPC (production ~0.4-0.8 ms/msg, so 40-80 s at 100k).
- Root exact reads failed closed for every active intent state and routing refused `migrating`, so
  a multi-tick migration would be unreadable for hours.
- A late writer at the flip (`terminal_version_changed`, a new attention marker) threw, retried,
  and poisoned toward the project breaker.
- The 10k gate is `min(SWEEP_MESSAGE_BUDGET=10000, write-budget ceiling)` in the compact SQL; the
  estimator caps at 100k units, making sessions above ~40-50k messages unaffordable.
- Production config: factor 2, allowance 2.4M, so the write-budget ceiling is 600k messages at
  100% overhead; a 100k-message session estimates roughly 445k writes.

Checklist:

- [x] Resume past `target_prepared` without the root prepare (`migrateClaimedCandidate`); flip
      re-proves the root unchanged.
- [x] Deadline threaded into the copy chunk loop, verification pages and phase boundaries; a claim
      yields only after it has made progress (`ClaimProgress`, `shouldYield`).
- [x] Yield releases the lease and resets `attempt_count` when the claim advanced
      (`releaseYieldedLease`); a failure after progress also resets it (`markFailed(progressed)`),
      so poison = `POISON_AFTER_ATTEMPTS` consecutive no-progress claims.
- [x] Lease renewal at chunk, page and phase boundaries (`renewLeaseIfDue`).
- [x] Reserve writes once, at journal creation; `reserveMigrationAttempt` deleted.
- [x] Estimator cap 100k -> 1M units (`ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS`).
- [x] 10k gate removed from the unscoped sweep; the canary keeps its packing budget.
- [x] Paged compact R2 verification before the flip (`verifyArchiveTargetPage`, progress in shard
      `do_meta`), per-call budget `PROJECT_DATA_ARCHIVE_R2_TIMEOUT_MS`; failures return as values.
      Resumed seals skip the whole-session recompute (`skipCompactRecoveryRecompute`).
- [x] Flip-or-unwind: `archiveSourceFlip` returns eligibility / terminal-version refusals;
      `unwindFlipRefusal` abandons source then target and leaves a `precopy_refused` marker.
- [x] `migrating` reads route to the root; root reads refuse only after the flip
      (`isSourceExactReadFenced`); writes stay fenced.
- [x] PR A carry-overs: deterministic reclaim deadline test; stuck-reclaim operator signal
      (`reclaimStuck`, `project_data_archive_reclaim_stuck` error log); reclaimed bytes per page.
- [x] Tests: `tests/workers/project-data-archive-resumable-cursor.test.ts` (8 scenarios); throughput
      suite drives 10,500- and 20,000-message sessions to publication; unit and Workers suites
      updated.
- [x] Docs: `configuration.md` archive section, `wrangler.toml` comments.
- [x] Discrimination runs per guard (rounds 1-3 recorded in Notes).
- [ ] Local specialist review; CI; staging on the compact config; parent review of the exact SHA.

Review round 1 (2026-11-13, head ab10ea984) and fixes (commit 327f3db1f):

- task-completion-validator FAIL: HIGH verification redone counted as progress (poison never
  fires); HIGH paged verification barely tested; MEDIUM estimator cap, stale lease, reclaim
  deadline determinism, flip/prepare hash still whole-session, maintenance audit, drain arithmetic.
- adversarial reviewer: HIGH grouped/tool rows no longer checked against the root before the flip;
  HIGH verification progress discarded yet counted; MEDIUM unwind not crash-safe; MEDIUM repeated
  flip refusal re-copies daily.
- cloudflare-specialist: HIGH unpaged target abandon in the unwind can hit the CPU limit and a
  partial unwind poisons; MEDIUM token not rotated on resume; MEDIUM progressed failure pays the
  1 h retry delay and a re-prepare; MEDIUM refused candidates re-scan every tick; MEDIUM R2 not
  re-checked between verification and flip; LOW frozen reads, listing cost, UTF-8 ordering.
- Parent (01M77TZWBDJHQ3Z87V2NYZMFK1): bound every whole-session root operation with a version or
  write fence, or with measured enforced bounds; a projected 9 s root block is not acceptable.

- [x] Write-generation fence: DO migration `076-archive-source-write-generation` (counter table,
      intent columns `prepared_write_generation` / `terminal_components_json`, INSERT/UPDATE/DELETE
      triggers on messages, grouped rows, tool-payload archives, chat_sessions anchor columns and
      message comments, counting only pre-flip sessions and real hashed-column changes).
- [x] Prepare in three phases: fence + generation under the lock, unlocked yielding hash, generation
      re-check under the lock (`beginArchiveSourcePrepare` / `completeArchiveSourcePrepare`).
- [x] Flip proves by write generation in O(1) (`finalizeSourceDelete` `proveByWriteGeneration`);
      legacy intents and the old RPC re-hash.
- [x] Root records terminal components; final verification page compares the shard's anchor,
      grouped and tool rows (`assertTargetComponentsMatch`).
- [x] Verification verdicts persist (complete / failure); timeouts keep progress; UTF-8 ordering.
- [x] Resumable, paged, crash-safe unwind (`unwindFlipRefusal`, `archiveTargetAbandonPage`,
      finish-unwind branch, `flip_unwinding` marker preserved by release and markFailed).
- [x] Progressed failure keeps the phase and retries next tick (`releaseYieldedLease` with error).
- [x] Token rotation on resume (`archiveSourceReattachToken`).
- [x] Write-budget floor refusal before the root estimate scan.
- [x] Renewal leaves an already expired lease to `assertLeaseStillHeld`.
- [x] Tests: unit `project-data-archive-write-generation.test.ts` (7); workers resumable-cursor
      11 scenarios (adds flip-fault poison, anchor component mismatch, interrupted unwind, real
      bypass writer via `markAgentCompleted`, verification counted once across ticks).
- Deferred with justification (MEDIUM/LOW): R2 HEAD re-check between verification and flip (R2
  durability; the window is one tick at most); orphaned R2 objects after an unwind (storage only;
  bounded by refusals per day); routing `frozen` reads to root; exponential backoff for repeated
  flip refusals (bounded to one copy per session per day by the 1-day refusal window and visible
  as `flipUnwound`). Backlog: `tasks/backlog/2026-11-13-archive-verify-r2-recheck-and-orphans.md`,
  `tasks/backlog/2026-11-13-archive-frozen-reads-and-unwind-backoff.md`; SAM ideas
  `01M79RQ1YZ5SHDQT15B08WW8T7`, `01M79RQ94GFC2Q0TCH54MVN5MY`.

Measurement (2026-11-13, local better-sqlite3 + node:crypto, NOT production): 100,000 messages
(512 B bodies) + 50,000 grouped rows: prepare hash 1,820 ms over 302 yields, longest uninterrupted
slice 70 ms; flip 1.0 ms; write estimate 23 ms. Production per-row cost has been ~1.5x local.

Drain vs ingress (rule 81; projections from production measurements, not measurements):

- Write budget: production 2026-11-13 reserved 165,678 writes for 68,352 published messages
  (~2.4 writes/message), so 2.4M/day admits ~1M messages/day.
- Tick time: ~13.7k messages per 60 s tick measured for 10k-capped sessions; large sessions cost
  ~3 ms/message (copy 2.2 + verify 0.4-0.8 + prepare ~0.03), ~20k per tick; 80 ticks/day gives
  ~1.1-1.6M messages/day.
- Binding constraint ~1M/day against ~85k/day ingress; the 6.6M-message eligible backlog
  (575k + 1.92M + 4.10M) clears in roughly a week.
- Retry schedule: a failure after progress retries next tick (18 min); a no-progress failure waits
  `FAILED_RETRY_DELAY_MS` (1 h) and poisons after 3, so a permanently broken migration is
  surfaced within ~3 h.

Measurements (2026-11-13, local workerd, NOT production): a 20,000-message production-shaped
session migrates, verifies, flips and reclaims inside a 46.4 s test that also seeds the session
and reads the whole transcript back (upper bound ~2.3 ms/msg); 10,500 messages in 23.0 s.

Bounds at the outer probable limit (100k messages, rule 81), production-derived projections:
copy ~1.1 s per 500-row chunk (200 chunks, ~220 s, ~4-5 ticks of 60 s); verification ~0.4-0.8
ms/msg in R2-timeout-bounded pages (~40-80 s, 1-2 ticks); prepare hash ~3 s in yielding
500-row slices (local 1.8 s, longest slice 70 ms); flip O(1) via the write generation (local
1 ms; superseded the earlier ~9 s recompute projection); reclaim ~10-60 s in 500-row pages
(1-2 ticks). Total ~7-10 ticks
(~2-3 h at the 18-min cadence), readable throughout. One reservation of ~445k writes.

Production after #2700 (read-only D1 `sam-prod`, 2026-11-13 01:55Z, normal operation only):

- Since the 00:20Z deploy (~1.5 h, ~5 ticks): 9 publishes, 68,352 messages (max 9,394, avg ~7.6k),
  i.e. ~13.7k messages per tick, versus 1 session per tick before. Measured, small sample.
  Projection at 80 ticks/day: ~1.1M messages/day of 10k-capped sessions against ~85k ingress.
- Refusals since deploy: 24 `active_session_state`, 4 `message_comments_present`; 28 reservations
  released (517,454 writes) — every refusal refunded. No failed or poisoned migrations; all 3
  breakers closed; cadence `succeeded`, `consecutive_budget_stalls` 0.
- Write budget window 2026-11-13: 165,678 of 2.4M reserved.
- Eligible root backlog (stopped/failed, root): le1k 2,941 / 575k msgs; 1k-10k 499 / 1.92M;
  > 10k 202 / 4.10M (the PR B target). Sleeping: 290 sessions / 843k msgs.
- Open question: 24 `active_session_state` refusals remain after dropping `'error'`; these are
  `prompting`/`recovering` or `runtime_work_state` active/settling on sessions terminal for the whole
  grace. Not yet attributed (needs a DO-side read); not changed in PR B. Backlog:
  `tasks/backlog/2026-11-13-archive-active-session-state-refusals.md`; SAM idea
  `01M1V3WYT6D88Z41WQWP0ASVC3` (updated).

Audit notes:

- Root-local maintenance while rows await reclaim (PR A audit, unchanged): tool-payload cleanup
  can strip a leftover row's payload during the reclaim window; bounded to one cadence. Before the
  flip, transcript writes are fenced by the source intent and the write-generation triggers count
  any write that slips through (materialization, grouped-FTS cleanup, tool-payload cleanup, late
  callbacks such as `markAgentCompleted`); the flip then refuses and the migration unwinds instead
  of poisoning. The cost is a wasted copy at most once per session per refusal window.
- `source_deleted` = flipped and published, reclaim may be outstanding; the root marker
  (`archive_reclaim_pending:`) drives reclaim, not the journal.
- Mixed version: old coordinators keep calling `archiveSourceFinalizeDelete` (throwing contract)
  and `archiveTargetSeal` without `skipCompactRecoveryRecompute` (whole-session recompute), so a
  rollout window behaves as before. A downgrade leaves `migrating` sessions unreadable again and
  re-reserves on resume; verification progress keys are inert.

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

- 2026-11-13 00:50Z handoff: task `01M795CM7DAPCSF4E94AJK09CP` (replacement sole owner, previous
  task `01M784YVJMQN6Z49XJRTJDVKPV` cancelled by user). PR A rebased from the old #2700 branch
  (`578d1fdeb`) onto main `671c230c3` (#2700 squash tree is identical to that branch tip); 5 commits
  replayed cleanly; typecheck, eslint and 7 archive Workers suites (113 tests) green; #2702
  retargeted to `main`. PR B goes on a branch stacked on PR A. All PRs stay DRAFT until the parent
  coordinator `01M77TZWBDJHQ3Z87V2NYZMFK1` reviews the exact head SHA.
- 2026-11-12 17:06Z workspace was recycled while paused; untracked `.do-state.md` was lost.
  Keep durable state here and push.

Review round 2 (re-review at bf61a717c) and fixes:

- All three reviewers: HIGH a transient R2 read error during verification was persisted as a
  permanent verdict (poison after one blip). Fixed: only deterministic mismatches are recorded
  (`DETERMINISTIC_VERIFY_FAILURES`); other errors keep progress and retry.
- MEDIUM: chunks verified before a timeout/error were not credited. Fixed: `counted` returned on
  every path and added to claim progress before the failure is raised.
- MEDIUM: legacy (pre-076) intents took a whole-session seal and flip, and the legacy re-seal
  counted as progress. Fixed: a resumed claim re-prepares such an intent (yielding hash, records
  generation and components); the legacy coordinator seal branch is removed.
- MEDIUM: the fence fails open if triggers are missing or columns drift. Fixed: the flip re-hashes
  unless all 18 triggers exist (`archiveWriteGenerationFenceInstalled`); a test pins every trigger
  column to `archiveTerminalHashedColumns()`.
- MEDIUM: operator abandon used the unpaged target delete. Fixed: paged loop.
- LOW: intent replaced during re-prepare (now detected by `created_at`), generation rows never
  deleted (dropped with the last reclaim page), shard component hash page size (configured).
- Deferred (MEDIUM/LOW, backlog files above): R2 re-check between a completed verification and a
  delayed flip; orphaned R2 objects after an unwind; `frozen` reads; repeated-refusal backoff;
  verify `do_meta` verdict rows kept per archived session (~200 B each on the shard).
- Discrimination round 3: deterministic-only verdicts (transient verify test), legacy re-prepare
  (pre-fence intent test) — both red when reverted.

Discrimination, round 2 (each guard reverted alone; the intended test went red, the others
stayed green): flip write-generation proof (workers bypass-writer test and unit flip test),
prepare generation re-check (unit mid-hash write), shard component check (anchor test),
verification verdict kept on completion (flip-fault poison test; reverting to "delete progress
on completion" reddens it), finish-unwind branch (interrupted unwind test), progressed-failure
release (transient R2 test), budget floor (lower-bound test), token reattach (unit token test).
Round 1 (renewal, reserve-once, yield reset, failure reset, unwind, verify, migrating reads,
stuck past deadline) was recorded at 02:05Z.

- 2026-11-13 06:10Z: #2681 (worker extraction) merged as 57614ec6b. Parent approved folding PR B
  (#2704) into #2702: one combined draft PR, one staging window, exact-head parent review, no merge
  approval yet. Port: PR A + B squashed and rebased onto 57614ec6b; code now in
  `packages/project-data/src/{do,archive,scheduled,client}` (DO migration 076 in
  `packages/project-data/src/do/migrations.ts`, worker tests import
  `@simple-agent-manager/project-data/internal/...`). CI failures on #2704 head 0b68080bf fixed in
  the port: import order, DO migration gate (trigger SQL frozen as literals; the gate test allows
  `CREATE TRIGGER IF NOT EXISTS` only when its body neither deletes nor drops), AST sql-injection
  (`DELETE FROM ${table}` split into two literal statements).

### Parent review of d41148b29 (2026-11-13)

- BLOCKING (fixed): `processArchiveMigrationBatch` kept a per-tick `reservedToday` cache that
  `reserve()` incremented but `releaseUnused()` never lowered. A large candidate reserved and then
  refused by the root (refunded in D1) left the cache overstated, so smaller affordable candidates
  behind it in the same tick were floor-refused (`window_exhausted`). Fix: a successful refund sets
  the cache to null so the next floor check re-reads D1 (one extra D1 read per refunded refusal; a
  failed refund leaves D1 unchanged and keeps the cache).
- Scenario test `admits a smaller candidate in the same tick after a larger reserved one is refused
and refunded` (resumable-cursor suite, real DO/D1/R2). Discrimination: with the invalidation
  commented out, `budgetWindowExhausted` is 1 and the test is red; restored, green.
- PR summary corrected: the first prepare still traverses the whole session, in bounded yielding
  pages outside the transcript lock, with a generation re-check under the lock.

### Staging finding on 9d02820 (2026-11-13): the reclaim pass starved the sweep

- Setup: staging deploy of 9d02820 with temporary vars `PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS=259200000`
  and `PROJECT_DATA_ARCHIVE_WALL_TIME_MS=3000` (confirmed on the deployed Worker), to give real
  ticks a workload, since every remaining 7-day candidate was already frozen. 74 real sessions were
  eligible (86 in the 3-7 d band, 12 blocked by live snapshots), with no journal rows.
- Symptom: ticks at 07:31 and 07:36Z ran (`run_count` 4068 to 4069) but journaled nothing. The 07:36
  tick took exactly 20 s against a 3 s wall.
- Cause: `reclaimPendingSources` ran first on every tick. It selected up to
  `max(sweepProjects, sweepSessions)` = 50 projects with ANY `source_deleted`/`published` journal row
  (21 on staging) and made 2 root-DO RPCs per project (`ensureProjectId` plus
  `archiveSourceListReclaimPending`), deliberately even past the deadline. D1 had no record that a
  reclaim had completed, so every tick re-listed every recently published project. The candidate
  batch then started out of time. In production this would be up to 100 root-DO RPCs per 5-minute
  tick (the rule 47 cron budget is 30/tick), every tick, for nothing.
- Fix: D1 migration 0237 adds `project_data_archive_migrations.reclaim_pending INTEGER NOT NULL
DEFAULT 1` plus a partial index. The pass selects only projects with a flagged flipped row.
  - The default covers pre-existing rows, rows an older coordinator writes during a deploy, and
    crash-gap rows (still `recovery_manifest_persisted` until the claim resume aligns them).
  - The flag is cleared by a completed reclaim (post-flip or pending pass), or by a complete
    listing (`pending.length < limit`) that omits a row snapshotted from D1 BEFORE the listing.
  - That snapshot is the fence against a concurrent flip: the root commits the flip before the
    journal CAS, so a row already flipped in D1 at snapshot time has its marker visible to the
    listing. A timestamp margin was rejected because journal times are the claim's start, not
    the flip's time (parent review).
  - The DO listing now returns copy-back-fenced sessions with `fenced: true` instead of omitting
    them, so an omission really means no marker. The pass skips fenced sessions as before.
- I/O: steady state is 1 D1 read per tick and 0 root-DO RPCs. A project with a real leftover
  costs 1 D1 snapshot read plus 2 RPCs plus the reclaim pages.
- Production one-time drain (read-only prod D1, 2026-11-13): 3,721 flipped rows in 30 projects,
  at most 2,930 in one. The first tick lists all 30 once (about the per-tick cost without the
  fix). Small projects clear in that listing. The large project clears 50 rows per tick, so about
  59 ticks (~5 h at 5 min) at 1 listing per tick, then 0.
- Tests: new `apps/api/tests/workers/project-data-archive-reclaim-flag.test.ts` (5 scenarios,
  real DO/D1/R2):
  1. 12 clean published projects with 150 ms listings plus 1 candidate under a 600 ms wall: the
     candidate migrates and the clean roots are never listed.
  2. An older or default flag is listed once, then cleared and never listed again.
  3. A leftover keeps its flag until it is reclaimed.
  4. Crash gap: the journal is reset to `recovery_manifest_persisted` with location `migrating`
     over a flipped root. The rows are reclaimed and the flag cleared.
  5. Canary race: a row flagged during the listing, timed as an earlier claim, keeps its flag.
- Discrimination, run before the workspace recycle (each reverted alone, then restored
  byte-identical):
  - (a) dropping the `reclaim_pending = 1` filter: the starvation test (8 s, candidate not
    migrated) and "never again" go red;
  - (b) reading the snapshot after the listing: the race test goes red;
  - (c) making `renewLeaseIfDue` a no-op: the strengthened renewal test goes red;
  - (d) excluding fenced sessions from the listing: the copy-back fence test goes red.
- The workspace was recycled during the provider pause (08:12-11:00Z) before this was committed.
  The patch was reapplied from the session transcript and re-validated (see below).

### CodeRabbit review of 9d02820 (07:33Z, CHANGES_REQUESTED)

- Minor: the unit `archiveSourceFlip` fake delegated to the old delete-at-flip finalize. It now
  returns zero deletions and unchanged size; the first `archiveSourceReclaimPage` reports the
  deletions.
- Nitpick: the renewal test could pass without renewal. R2 puts are now slowed by 40 ms, so the
  claim outlasts the 400 ms lease more than 3 times over. Proven by (c).
- Nitpick: the copy-back fence test never reached reclaim. It now calls `archiveSourceReclaimPage`
  directly inside the fence (0 deleted, `copyBackInProgress: true`), and a marker under the fence
  is listed as fenced, skipped, and keeps its flag. Proven by (d).

### Staging read checks (Playwright, 06:57Z, on d41148b29)

- An archived r2-gzip session (`4745a38a`, 209 messages) renders in the app via the
  token-login session; the messages API returned 200 (200 rows, hasMore).
- The workspace 404s on that page predate this PR (a root-resident session shows the same).
  Filed `tasks/backlog/2026-11-13-chat-page-fetches-deleted-workspace.md`.

### Staging verification of 78d730816 (2026-11-13, real cron ticks)

- Deploys: 43419240892 (3 s wall), then 43423564515 (production 60 s wall). D1 0237 applied.
- Backfill vs steady state: 0237 flagged 1,185 published rows in 22 projects. Ticks 4101-4110
  cleared them per project, 50 per listing (1,185 → 899 → 579 → 427 → 209 → 158 → 108 → 58 → 8 → 0).
  Tick 4109 read a lagging D1 replica snapshot and cleared nothing new; a stale snapshot only
  under-clears (each row in it had already flipped, so its marker existed). After tick 4110 the pass
  query selects 0 projects, so steady-state ticks wake no root object for reclaim.
- Candidates with the drain (60 s wall, migrations created since 11:50Z):
  - 29 published (2,305 messages);
  - 4 `precopy_refused` (`active_session_state`), all refunded (10 receipts / 15,414 writes today);
  - 0 failed or poisoned; the breaker stayed closed.
- Flip, then reclaim across ticks: `c156f907` flipped at 11:51:54Z with 0 rows deleted. The pending
  pass reclaimed it at 12:01:22Z (665 rows, 253,952 bytes) and cleared the flag.
- Multi-tick copy resume: `8e1dd3ad` yielded in tick 4109 (63.8 s, `copying`, attempt 0) and
  published in tick 4110.
- Reads (Playwright, token-login): `c156f907` 606/606 and `f4d7e243` 565/565 unique messages from
  the shard, both rendered.
- Search: no REST message search in the app; covered by the Workers suites only.
- Restore: all 4 temporary vars deleted (none were set before), and `main` redeployed to staging
  (run 43430902403).
- Recovery gap during the provider pause (worktree outside the primary checkout lost): idea
  `01M7A9VY2A3TPGEA5XV9G9G8BT`.
