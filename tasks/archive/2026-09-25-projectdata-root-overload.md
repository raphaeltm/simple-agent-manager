# ProjectData root DO overload: bound the root search, gate alarm sections, classify resets

SAM task `01M3BQVK3DG09RWJV1DQPXSNVT`, output branch `sam/find-fix-makes-sam-pxsnvt`.
Ideas: `01M27M86R544BQX86VZANZGSQ2` (alarm), `01M1XKK208SJV9VJA4BXP2KBHT` (CPU-reset
classification), `01M1BKG7BE6HD81QC1Y0HBQVSJ` (activity callback retry amplification).

## Problem

The SAM project's root ProjectData Durable Object (9.9 GB, 99% of its configured limit) throws
`Durable Object is overloaded` / `exceeded its CPU time limit and was reset` errors on unrelated
routes (chat WebSockets, activity callbacks, node heartbeats, comments) almost every day, mostly in
the 15:05Z daily blog-post window. On 2026-09-24 it was also unreachable for 33 minutes.

## Research Findings (measured 2026-09-25, read-only production queries)

All measurements: Workers Observability (`CF_PRODUCTION_DEBUGGING_TOKEN`), prod D1 `sam-prod` and
`sam-observability-prod`. SAM root DO id `dd1dc7854bfe6d171cb7db70805b7dc3262566c4b685217736bd43af61d59960`.

1. **Every overload / CPU-reset error on the root DO in 7 days follows one `searchMessages` RPC.**
   Workers Observability jsrpc events on the root DO with `cpuTimeMs > 1000`, 09-18..09-25:
   - `searchMessages` ×10: 7 × `exceededCpu` (cpu 32,500 ms, wall 63-79 s), 2 × ok (25.5 s / 27.8 s
     CPU, ~59 s wall), 1 × canceled (27 s CPU). Times: 09-18 15:08:42, 09-19 02:40:22,
     09-20 16:01:28, 09-20 19:56:51, 09-21 03:15:57, 09-21 15:10:08, 09-22 14:42:08,
     09-23 15:09:45, 09-23 22:26:14, 09-24 15:14:33.
   - Each lines up with the platform_errors overload/CPU-reset rows: 09-18 15:09:33, 09-20
     16:02:07-16:02:47 (9 overload + 1 CPU reset), 09-20 19:58:05 (CPU reset), 09-23 15:10:50,
     09-23 22:25:53, 09-24 15:15:18. 12 of 13 overload rows + all CPU resets are explained.
   - 09-24 15:15:38 `mcp.tool_call_failed {"tool":"search_messages","error":"Error: Durable Object
exceeded its CPU time limit and was reset."}` — the daily blog agent's project-wide search.
   - Other >1 s CPU root RPCs: `archiveSourceFinalizeDelete` ×33 (1.6-6.5 s; archive drain, out of
     scope), `archiveSourceSearchMessages` ×2 (up to 4.7 s; session-scoped search), `sleepSession`,
     `stopSession`, `failSession`, `admitProjectEvent` (1-2 s).
2. **Root cause in code:** `messages.ts:searchMessages` runs FTS (`ORDER BY rank`, computes bm25 for
   every match) and, when FTS returns < `limit` rows (any specific/rare query), the LIKE fallback
   `searchMessagesLike`, whose plan is `SCAN m` + temp B-tree: a full scan of `chat_messages`
   (7.4 M rows / 3.2 GB content on 2026-08-26) evaluating `content LIKE '%q%'`.
   Local benchmark (better-sqlite3 3.53.2, real DO migrations + materializeSession):
   - 2.4 M rows / 273 MB: no-match search 350-480 ms (full LIKE scan); scales with content bytes.
     Production per-byte cost ≈ 5.7× local (30 s / 3.2 GB vs 0.45 s / 273 MB).
   - LIKE with a newest-rowid window (`m.rowid > max - W`): 4 ms (W=20K), 10 ms (50K), 25 ms (100K);
     plan `SEARCH m USING INTEGER PRIMARY KEY (rowid>?)`.
   - FTS at 500 K grouped docs: current 0.78-1.0 s for common terms (bm25 over every match),
     2.1 s when a role filter rejects the matches. Bounded window (floor = K-th newest match, bm25
     only for rowid >= floor): 38-182 ms (K=2 000-10 000), 40 ms worst case.
   - Session-driven FTS (`CROSS JOIN` rowid probes) is catastrophic: 166 s on a 20 K-doc session —
     rejected.
3. **The 2026-09-24 16:01-16:35Z outage was platform unavailability, not an alarm section.** The root
   DO recorded ZERO invocations of any type between 16:01:46 and 16:35:00. Worker-side calls failed
   fast (~190 ms) with `Network connection lost.` (360 from one ACP session, 126 from another).
   The DO recovered at 16:35:00; the alarm fired at 16:35:18 and ran the OVERDUE daily tool-payload
   cleanup (due ~16:28 from the previous 16:28:14 pass; 20.8 s, 17 rows) — the cleanup finishing
   "the same minute" is a consequence of recovery, not the cause. Nothing in our telemetry explains
   the unavailability; it is correlated with object size (restore/relocation of a ~10 GB object),
   which is the archive-drain work tracked elsewhere (out of scope).
4. **Current alarm cost on the root DO is small in CPU:** 00:50-06:59Z 09-25 sample: 1 tick/min,
   `ok` ticks CPU 30-48 ms, wall 0.98-1.95 s (mostly D1 I/O awaits, which do not block the DO's
   input gate). Storage safety alone logs 303-387 ms per tick because grouped-FTS cleanup returns a
   non-null `wall_unsafe` result every tick, so `persistCleanupHealthTelemetryAndAlerts` builds
   telemetry and upserts D1 every tick. Every other section free-rides on each tick.
5. **What drives 1 tick/min:** workspace `01M3A2CC76EVDPZY9693JKW1FW` (task
   `01M3A2C7T23QY2C92WYYVFGFWX`) has been idle 12.3 h past a 2 h timeout; every minute
   `checkWorkspaceIdleTimeouts` re-selects it, `terminalizeIdleTaskInD1` returns inconclusive
   (`task_acp_session_missing`) → `preserved`, no backoff, and `computeIdleAlarmTimes` clamps the next
   check to `now + 60 s` — an immortal candidate (rule 47). Filed as a separate idea (out of scope
   here; touches rule-58 terminalization semantics).
6. **Alarm schedule functions clamp overdue work into the future** (`max(raw, now + minDelay)`):
   heartbeat (`dueAt <= now ? now + window`), workspace idle check, reconciliation, activity probe,
   prompt delivery, mailbox (`now + poll`), storage safety cleanup markers (`notBefore`). So "is this
   section due?" CANNOT be answered by recomputing the schedule at alarm time — every clamped section
   would look not-due forever and starve. Gating must remember the earliest due time computed for
   each section since it last ran (min-accumulate), and overwrite it only after the section runs.
7. **Retry classifier:** `durable-object-retry.ts` patterns do not match Cloudflare's exact
   `Durable Object exceeded its CPU time limit and was reset.` (the `/durable object reset/` pattern
   needs the literal substring) nor `Network connection lost.`. `isTransientDurableObjectError` has
   four callers; two of them (`callProjectDataWithRetry`, `callProjectDataOwnerWithRetry`) retry
   mutations too, so the shared predicate must NOT be widened (rule 67) — compose new predicates.
8. **Activity callback amplification (idea 01M1BKG7...):** API-side admission/coalescing shipped in
   PR #1979 but only engages for errors `isTransientDurableObjectError` accepts; during the 09-24
   outage every intermediate report got a 500 and the VM retried it (5 attempts, fixed 1 s). The
   coalesced flush itself retries every `coalesceWindowMs` (2 s) until the 60 s TTL — up to 30
   attempts/min/session, more than the VM's observed ~11/min. VM-side jitter/terminal latch is
   rollout-coupled (rule 54) and stays in the idea.
9. **Open PR #2136** (slice B exhaustive archive search, `needs-human-review`) edits
   `services/project-data.ts:searchMessagesWithArchiveMetadata` and MCP `search_messages`, but still
   calls the same root `stub.searchMessages` RPC. Bounding the root search inside the DO benefits it
   too; the service-layer change here will need a rebase on whichever lands second.
10. **Workers clock:** `Date.now()` does not advance during synchronous execution in Workers/DOs, so
    per-section wall time reads ~0 for purely synchronous SQL sections. Per-section `rowsRead` /
    `rowsWritten` (SqlStorageCursor) attribute synchronous work.

11. **FTS5 and rowid bounds (measured in the workers runtime and better-sqlite3 during review):**
    a ranked query with `rowid >= floor` or `BETWEEN lo AND hi` still iterates every match of the
    term (rows read 3,170 for a 50-row window over 3,020 matches) — FTS5 checks the bound per row.
    A newest-first `ORDER BY rowid DESC LIMIT n` scan does stop early (50 rows read). bm25's IDF also
    counts each phrase's matches once per query (`xQueryPhrase`). So full-text cost keeps one linear
    pass over the term's matches (~60-70 ns each; ~30-60 ms at 500 K) no matter what; the window bounds
    scoring, joins and content reads, which is what cost 25-32 s. A session-scoped scan additionally
    steps over newer matches of other sessions before reaching its span.
12. **Existing tests drove the alarm with back-to-back forced ticks** (`instance.alarm()` twice) and
    SQL-aged state into the past. Under gating those ticks skip sections that are not due, so four
    tests failed and several absence-style tests passed vacuously; see checklist G.

13. **Durable Object eviction resets in-isolate memory (found on staging, 2026-09-25 11:00Z):** after the
    first deploy every `project_data.alarm.completed` on staging read `mode: full, fullRunReason:
first_tick`, including a project's next tick one minute later — idle ProjectData objects are
    evicted between minute-spaced alarms, so the scheduler's in-memory state reset every tick and
    gating never engaged (no regression: tick cadence was unchanged at one per minute per project).
    Fixed by persisting the scheduler memory in `do_meta` (checklist G).

## Implementation Checklist

### A. Bounded root search (primary fix; idea 01M27M86R544BQX86VZANZGSQ2 §3 / task scope 4)

- [x] Extract search from `messages.ts` (719 lines) into `message-search.ts`; keep re-exports.
- [x] FTS half: candidate window = newest `ftsCandidateLimit` matches, scored by bm25 inside one
      `ORDER BY rowid DESC LIMIT` scan (review round: a `rowid >= floor` ranked query still iterated
      every match — FTS5 checks rowid bounds per row); session-scoped search scans the session's
      grouped rowid span once; ties break on ascending rowid (= `ORDER BY rank`, = archive shard).
- [x] LIKE half: project-wide newest `keywordScanRowLimit` rows by rowid; session-scoped newest rows
      of that session by `(session_id, created_at)`; existing unindexed-tail predicate unchanged.
- [x] Coverage result `{ftsCandidateLimit, ftsCandidatesTruncated, keywordScanRowLimit,
keywordScanTruncated}`; env `PROJECT_DATA_SEARCH_FTS_CANDIDATE_LIMIT` (default 2000) and
      `PROJECT_DATA_SEARCH_KEYWORD_SCAN_ROW_LIMIT` (default 50000) with `DEFAULT_*` constants.
- [x] ProjectData RPCs `searchMessagesWithCoverage` / `archiveSourceSearchMessagesWithCoverage`
      with env bounds; the array-returning RPCs and the service `searchMessages()` wrapper lost their
      last production callers and were removed (tests use the coverage variants).
- [x] Service `searchMessagesWithArchiveMetadata` returns `rootSearchCoverage`; MCP `search_messages`
      response + tool description disclose it (rule 65); SAM `search_task_messages` tool too if it
      renders archive metadata.
- [x] Tests (workers runtime, real DO SQLite): results identical to old behavior under the bounds
      (incl. across archive migration — compact-archive suite); window excludes rows beyond the bound
      and reports truncation; session-scoped bound; the bounded SHAPE is proven by rows read per
      search (keyword and full-text; plans were checked with EXPLAIN QUERY PLAN during development);
      disclosure reaches the MCP and SAM tool responses.

### B. Alarm per-section measurement (task scope 1)

- [x] Section runner: per-section `status` (ran/skipped_not_due/failed), `durationMs`, `rowsRead`,
      `rowsWritten`; one `project_data.alarm.completed` log with projectId, totalDurationMs,
      mode (full/gated), ran/skipped/failed section names, slowest section; warn log per slow section
      (`PROJECT_DATA_ALARM_SLOW_SECTION_MS`, default 1000).
- [x] Row metering wrapper for `this.sql` (exec + databaseSize only), counting only while a section
      meter is active.

### C. Run only due alarm sections (task scope 2)

- [x] `computeProjectDataAlarmSections()` returns per-section times (single source for scheduling and
      gating); `computeProjectDataAlarmTime` = min over them (unchanged behavior).
- [x] In-memory per-section pending due map, min-accumulated on every `recalculateAlarm`, overwritten
      for sections that ran; alarm time = min(fresh, pending).
- [x] Full run when: fresh instance (no prior full run), full-run floor elapsed
      (`PROJECT_DATA_ALARM_FULL_RUN_INTERVAL_MS`, default 15 min), gating disabled
      (`PROJECT_DATA_ALARM_SECTION_GATING_ENABLED`, default true), or section computation failed.
- [x] Due tolerance `PROJECT_DATA_ALARM_DUE_TOLERANCE_MS` (default 2000).
- [x] Cascade: `task_waits` / `project_event_wake_materialization` running forces `prompt_delivery`
      in the same tick (preserves "dispatch a newly enqueued parent wake in this alarm turn").
- [x] Storage safety still runs first among due sections and stays isolated (firebreak semantics).
- [x] Tests: two-tick gating (not-due skipped, due runs), clamped-overdue section still runs on time
      (no starvation under repeated recalcs), fresh-instance full run, floor full run, kill switch,
      isolation (throwing section does not stop later ones; failed ≠ skipped in log), cascade.

### D. CPU-reset / connection-lost classification (task scope 3; idea 01M1XKK208SJV9VJA4BXP2KBHT)

- [x] `isDurableObjectCpuLimitResetError`, `isDurableObjectConnectionLostError` exact predicates;
      `isTransientDurableObjectError` unchanged (rule 67).
- [x] `callProjectDataWithRetry` takes an explicit idempotency declaration; CPU-reset and
      connection-lost are retried ONLY for idempotent reads (allowlist); mutations unchanged.
- [x] Stable sanitized error on exhaustion: an idempotent read that runs out of attempts on a
      CPU-limit reset or lost connection throws `ProjectDataUnavailableError` (503
      `PROJECT_DATA_UNAVAILABLE`, `services/project-data-rpc-retry.ts`); mutations keep the raw error.
- [x] Lost connections get their own attempt budget (`DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS`,
      default 3, capped at `DO_RETRY_MAX_ATTEMPTS`) — a sustained outage is not multiplied 8x.
- [x] Retry telemetry: `project_data.do_rpc_retry_succeeded` / `..._exhausted`.
- [x] Tests: first-attempt CPU reset then success for a read; bounded exhaustion; mutation not retried
      (no duplicate); shared predicate not widened (no-widening test).

### E. Activity callback amplification (task scope 5, API side)

- [x] Activity coalescing fallback (lookup, persist, flush) also engages on CPU-limit reset and
      `Network connection lost.` via a composed predicate.
- [x] Coalesced flush retries back off exponentially (bounded by the pending TTL) instead of every
      coalesce window.
- [x] Tests: 204 + coalesced (no VM retry) on connection-lost; flush retry count bounded under a
      persistent outage; terminal/non-intermediate reports still surface errors.

### G. Review round (local reviewers, 2026-09-25)

- [x] Scheduler: a remembered deadline between a section's start and the tick's recalculation stays
      due (heartbeat would otherwise slip a full 5-min detection window after an early/full run).
- [x] Unwired `PROJECT_DATA_ALARM_DUE_TOLERANCE_MS` / `_SLOW_SECTION_MS` added to deploy sync + both
      `wrangler_sync_env` blocks.
- [x] Retry core → `services/project-data-rpc-retry.ts`; coverage describer →
      `services/project-data-search-coverage.ts`; row helpers → `message-search-rows.ts`
      (`services/project-data.ts` now smaller than on main; `message-search.ts` < 500 lines).
- [x] Metered `SqlStorage` forwards `Cursor` / `Statement`.
- [x] Existing workers tests that drove back-to-back forced ticks: heartbeat tests now reproduce the
      production sequence (deadline observed, then passes) with a liveness assertion; multi-pass
      storage-safety tests run full ticks explicitly; absence-style alarm tests assert the section ran.
- [x] New real-alarm tests: schedule-refresh failure → full run; one section's broken schedule and run
      isolated; gated cascade into prompt delivery; FTS rows-read shape (project and session).
- [x] Docs: search cost wording corrected (bm25's IDF pass stays linear in matches); coalescing
      backoff; new retry knob.
- [x] Validator re-run: `reconcileTaskWaits` returned (not awaited) a promise that could reject
      before adoption, which workerd reported as unhandled (full workers run exited 1 with every test
      green); now awaited. The scheduled-actions background recalculation logs its own failure.
      Alarm-section tests arm no automatic alarm and let the clock move before manual ticks.
- [x] Scheduler memory persisted in `do_meta` (`serialize` / `restore`, write-on-change, never
      throws) so gating survives eviction; eviction tested with `ctx.abort()` plus a no-memory control.
- [x] Deferred (MEDIUM, pre-existing pattern): error text logged as plain strings bypasses the
      logger's Error redaction → `tasks/backlog/2026-09-25-structured-log-error-text-redaction.md`.

### F. Follow-ups / docs

- [x] File idea: immortal workspace idle-timeout candidate (finding 5) — idea `01M3BWCDAH45GQ9FQ728QPA2D8`.
- [x] Docs: env vars in `apps/api/.env.example`, env-reference skill, configuration reference;
      MCP tool description; architecture docs if they describe search/alarm behavior.
- [ ] Update ideas 01M27M86R544BQX86VZANZGSQ2, 01M1XKK208SJV9VJA4BXP2KBHT, 01M1BKG7BE6HD81QC1Y0HBQVSJ
      with measurements + PR link (after merge + production deploy).

## Acceptance Criteria

- [x] A project-wide root search against a large dataset examines at most the configured windows
      (verified by plan + bounded-row tests) and discloses truncation in the MCP response.
- [x] Alarm completion log names ran/skipped/failed sections with duration and rows read/written.
- [x] Alarm runs only due sections (plus cascades/floor); no section starves (clamp test).
- [x] CPU-limit reset retried only for idempotent reads, with a stable error code on exhaustion.
- [x] Activity callbacks answer 204 + coalesce on connection-lost / CPU reset; flush retries bounded.
- [x] Staging: search (agent MCP calls, project-wide + session-scoped), alarm logs (gated ticks after
      the persistence fix; storage safety 119 → 18 runs per comparable window), activity path exercised.
- [ ] Production: alarm logs visible, next 15:05Z blog window shows no overload errors (or the measured
      cause is documented in the idea) — verified after merge; results recorded in the ideas.

## References

- `.claude/rules/39`, `47`, `53`, `45`, `58`, `62`, `65`, `67`, `69`, `74`, `76`; `apps/api/.claude/rules/*`
- `apps/api/src/durable-objects/project-data/{index,alarm-schedule,messages,materialization}.ts`
- `apps/api/src/services/{durable-object-retry,project-data,acp-activity-admission,acp-activity-callback-flush,acp-activity-callback-handler}.ts`
