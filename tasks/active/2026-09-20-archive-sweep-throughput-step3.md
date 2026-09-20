# Archive sweep throughput — staged ceiling raise (PR #2109)

Status: in review. Ships `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` 5000 -> 10000 as step 1.
`PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` stays 8.

## Problem

The SAM project's root ProjectData Durable Object is at ~99.85% of its configured 10 GB limit
(`PROJECT_DATA_STORAGE_LIMIT_BYTES`), with ~7.9h of headroom at the observed growth rate. The
hourly archive sweep is the only sanctioned reclaim path (archive-then-delete, history and
search preserved).

`selectCandidates` binds `config.sweepMessageCeiling` into `AND ss.message_count <= ?` when
`PROJECT_DATA_ARCHIVE_COMPACT_ENABLED` is true. At 5000 that is not a pacing limit — it is a
selection predicate that makes larger sessions permanently unreachable.

## Measurements (2026-09-20, production D1 + Workers Observability)

All counts below apply `selectCandidates`' own predicates: terminal status, `ended_at` past the
7-day `_SESSION_GRACE_MS` cutoff, location `root`, breaker closed, no live snapshot. They
reconcile exactly with the root task's independent counts.

| Band (`message_count`) | Sessions | Messages  |
| ---------------------- | -------- | --------- |
| <= 5000                | 3344     | 3,443,235 |
| 5001 - 10000           | 266      | 1,830,972 |
| 10001 - 20000          | 23       | 340,676   |
| > 20000                | 13       | 407,727   |

**A 10000 ceiling reaches 266 of the 289 sessions (92%) and 1,830,972 of the 2,171,648 messages
(84%) that 5000 could not see**, at roughly half the per-candidate risk of 20000. That is the
reason step 1 is 10000 rather than 20000.

`message_count` is the selector's own ranking column, not a byte measurement.

### Write cost

`project_data_archive_write_budget` held 106,804 reserved writes for 23,427 published messages
across 5 sessions: ~4.56 **estimated** writes per message including the fixed 1000-unit
per-session charge, so ~2.17 inventory units per message at factor 2. These are reservation
estimates, not billed rows — the estimator is deliberately conservative and the two must not be
conflated.

Consequence at 10000: ~44,400 estimated writes per ceiling-sized candidate, so the 800,000
allowance admits ~18 per UTC window against 24 hourly ticks. The binding constraint moves from
the cadence to `_DAILY_WRITE_BUDGET`, and the daily message ceiling moves 24x5000 = 120k to
18x10000 = 180k. The daily write budget is unchanged in this PR.

### Per-candidate duration

Production `project_data_archive_candidate_migrated` events (48h to 2026-09-20):

| messages | chunks | totalMs | prepare | copy   | seal | manifest | finalize |
| -------- | ------ | ------- | ------- | ------ | ---- | -------- | -------- |
| 4658     | 12     | 37,513  | 688     | 24,015 | 5854 | 1375     | 5581     |
| 4704     | 12     | 33,582  | 714     | 22,462 | 4175 | 1295     | 4936     |
| 4829     | 13     | 31,672  | 826     | 19,388 | 4513 | 1421     | 5524     |
| 2932     | 8      | 21,215  | 797     | 12,617 | 2763 | 1301     | 3737     |
| 2938     | 8      | 19,941  | 700     | 11,468 | 2803 | 1228     | 3742     |
| 2951     | 8      | 28,846  | 1092    | 19,150 | 2988 | 1705     | 3911     |

Least-squares fit: `totalMs ~= 5783 + 6.0 * messages`, i.e. ~66 s at 10,000 and ~126 s at
20,000 (worst observed slope ~9.8 ms/message gives ~98 s and ~196 s). `_LEASE_MS` is 300000.
This is **wall time**, and says nothing about CPU: the phases are dominated by R2 and DO RPC
I/O. No `exceededCpu` / `exceededMemory` / `fatalInternal` errors appear in the ProjectData
namespace over the sampled window.

### What the largest compact session has ever been

4,994 messages (128 `r2-gzip-v1` publishes). Both 10000 and 20000 are extrapolations past it;
10000 is a 2x step, 20000 a 4x step.

### Reclaim rate — NOT validated, do not cite as a forecast

A least-squares fit over 98 hourly `project_data_storage_telemetry_history` intervals returns
~364 bytes reclaimed per archived message and ~36 MB/day ingest. The ingest figure cannot be
validated by agreement with the telemetry's own `growth_rate_bytes_per_day`, because that column
is observed NET growth and already contains the reclaim term. Treat both as indicative only.
No net MB/day promise is made in this PR.

Free-page bloat is ruled out as an explanation for the reported metric: workerd's
`getDatabaseSize` (`src/workerd/api/sql.c++`) subtracts `pragma_freelist_count` from
`page_count` before multiplying by page size.

## Rollout stages

1. **Step 1 (this PR): 10000.** Ship, then observe one clean production cycle — source deletion
   proof, exact transcript/search retrieval, breaker closed, actual rows / CPU / duration /
   cost, reclaimed bytes.
2. **Step 2: 20000**, only after step 1's evidence plus a real compact-path staging run. This is
   a normal reviewed config change, not a routine bump. The 20000 case in
   `tests/workers/project-data-archive-sweep-throughput.test.ts` is an experiment that supports
   the promotion; it does not authorise it.

## Out of scope (root owns these)

- `_SESSION_GRACE_MS` — not reduced.
- FTS safety gates (`PROJECT_DATA_GROUPED_FTS_CLEANUP_*`) — untouched. FTS cleanup refuses at
  >= 98% via `_WALL_UNSAFE_RATIO`, so batching changes there are inert right now.
- `_DAILY_WRITE_BUDGET` — unchanged at 800000.
- Event-log cleanup, ad hoc production deletes, migrations.

## Rule 70: deployed-value verification

GitHub Environment variables, checked 2026-09-20:

- `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` — absent from `production` (43 vars) and `staging`
  (16 vars). The checked-in value is the deployed value.
- `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` — absent from both. (Unchanged by this PR anyway.)
- `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` — **present in `production` at 800000**, identical
  to the checked-in value. No divergence today, but a future `wrangler.toml`-only edit to that
  var would not ship.

Post-deploy verification of the deployed value is recorded in the PR body.

## Tests

- `tests/workers/project-data-archive-sweep-throughput.test.ts` — drives the real
  `runProjectDataArchiveSharding` over one fixture, twice, differing only in the budget.
  Tick 1 at 5000: the ceiling-sized session does not move (absence) while a 40-message session
  does (liveness). Tick 2 at the ceiling: published with an aggregate hash, source emptied,
  >= ceiling/500 R2 chunks, the full transcript read back through
  `projectDataService.getMessages` and compared id-for-id in order with content and tool
  payloads, search exercised session-scoped and project-wide, and root `databaseSize` asserted
  to have fallen. Fixtures carry ~2 KB assistant bodies, a tool call every 7 rows, and
  consecutive same-role runs so grouping and the chunker see production-shaped input. A second
  case repeats all of it at 20000 as an explicit experiment.
- `tests/unit/project-data-archive/sweep-message-budget-shipped.test.ts` — pins the shipped
  value against `wrangler.toml`, proves the sweep budget is the smaller of the two ceilings,
  proves a ceiling-sized candidate is reservable against a real SQLite engine, and asserts the
  daily-ceiling gain together with the constraint move.

Discrimination proofs recorded in the PR body.

## Findings worth keeping

- A 20,000-message session with production-shaped bodies cannot be read in one
  `getMessages` call: the DO RPC size guard truncated at 12,035 rows / 31.4 MB
  (`messages.rpc_size_guard_truncated`). That is rule 50 behaving correctly, but any client
  reading a large archived session must page. Not a regression from this PR.
- `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` is inert as a throughput lever while `_WALL_TIME_MS`
  (10 s) is below one candidate's real duration. The wrangler comment now says so.
