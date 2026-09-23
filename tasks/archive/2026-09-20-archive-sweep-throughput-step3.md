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

Widening the sample to 16 distinct migrations (24 h window plus the six above) gives
`totalMs ~= -8194 + 10.47 * messages`: **~97 s at 10,000 and ~201 s at 20,000**. Do not use the
earlier, narrower fit (`5783 + 6.0 * messages`, ~66 s / ~126 s) — it was fitted on a sample that
excluded the slow tail.

Duration is only loosely predicted by message count. Thirteen migrations clustered at ~4.7k
messages span **17,129 ms to 56,034 ms — a 3.3x spread at essentially constant size**, so
variance is dominated by something other than message count (R2 latency and DO contention are
the candidates). The worst observed rate is 11.81 ms/message, i.e. **~118 s at 10,000 and ~236 s
at 20,000**. Against `_LEASE_MS = 300000` that is 2.5x margin at 10,000 and only **1.27x at
20,000** — an independent reason to stage rather than jump to 20000.

Cron Trigger wall ceiling is 15 minutes, so wall clock is not binding at either size.

### Chunk density — measured, not assumed

Across the same 16 migrations, `chunksCopied` gives **365-397 messages per chunk** (p50 392;
rows per chunk across all tables 398-448). The 500-row `_CHUNK_ROWS` cap binds, not the 2 MiB
compact byte cap — production message bodies are small enough that no sampled session was
byte-dense. A 10,000-message candidate is therefore **~25-27 chunks**, not hundreds.

### What the largest compact session has ever been

**4,994 messages.** (Separately, 128 migrations have published in `r2-gzip-v1` format overall —
that is a count of publishes, not of chunks. An earlier draft of this file put those two numbers
in one sentence and a reviewer reasonably read it as "128 chunks for one 4,994-message session",
which would have implied ~39 messages/chunk and roughly ten times the chunk count measured
above.) Both 10000 and 20000 are extrapolations past 4,994; 10000 is a 2x step, 20000 a 4x step.

### CPU — measured separately from wall time, with a known gap

The durations above are **wall time**. On CPU:

- **Durable Object CPU.** `durableObjectsPeriodicGroups` for the ProjectData namespace over
  2026-09-17..20 shows no `exceededCpu`, `exceededMemory` or `fatalInternal`. Each incoming DO
  RPC gets its own fresh CPU budget, so the per-call risk does not accumulate across a migration.
- **Coordinator Worker CPU.** `workersInvocationsAdaptive` for `sam-api-prod` over the last 7
  days: **594,725 invocations, outcomes only `success` / `clientDisconnected` /
  `responseStreamDisconnected`, no `exceededCpu`, max `cpuTimeP99` 128 ms.** No invocation was
  CPU-killed at the current 5000 ceiling.
- **Per-invocation scheduled CPU — STILL AN OPEN GAP.** The aggregate above is taken across all
  requests, so it cannot isolate the one hourly archive tick. That matters because
  `writeCompactChunk` (`apps/api/src/project-data-archive/compact-r2.ts`) runs gzip + SHA-256 +
  gunzip + SHA-256 + `JSON.parse` in the **coordinator's** isolate, inside the single
  `scheduled()` invocation, with no per-chunk CPU reset — unlike the DO side. At the measured
  density a 10,000-message candidate is ~25-27 chunks against ~12 today, so the coordinator does
  roughly twice today's compression and hashing work per tick.

  **`workersInvocationsAdaptive` structurally cannot close this gap.** It has no trigger or
  event-type dimension — verified by GraphQL introspection; the dimensions are `cacheStatus,
  coloCode, datetime*, dispatchNamespaceName, environmentName, isDispatcher, isPreview,
  previewSlug, scriptName, scriptTag, scriptVersion, status, usageModel` — so a scheduled
  invocation cannot be selected. More importantly it exposes **no per-invocation row at all**:
  every field it returns is an aggregate over the bucket.

  **What the minute buckets do show: correlation, and only correlation.** Bucketing
  `sam-api-prod` by `datetimeMinute` on 2026-09-20 and reading `max { cpuTime wallTime }`, the
  two minutes that precede a `project_data_archive_candidate_migrated` log stand well above
  their neighbouring minutes, which serve as controls because the sweep is hourly (buckets are
  keyed by invocation START, so a long tick lands one or two minutes before its completion log):

  | Minute | max wallTime in bucket | max cpuTime in bucket | migration logged |
  | --- | --- | --- | --- |
  | 08:25 | 76 s | 518 ms | 08:26:31, 4,650 msgs, totalMs 23,981 |
  | 08:22-08:28 controls | 2 s | 15-64 ms | — |
  | 05:10 | 113 s | 652 ms | 05:12:49, 4,658 msgs, totalMs 37,513 |
  | 05:11-05:14 controls | 0-1 s | 14-33 ms | — |

  **What this is not.** `max { cpuTime }` and `max { wallTime }` are two *independent* maxima
  over the same set of invocations. The dataset does not report that they came from the same
  invocation, so these rows are not a joined per-invocation observation, and **518-652 ms is not
  a measurement of the archive tick's CPU.** A bucket maximum is also not a bound on the other
  invocations in that minute. The dataset is adaptive (sampled), and only 2 of the 4 recent ticks
  separated from their controls at all. Subrequest totals are likewise sums over every invocation
  in the minute, so no share of them can be attributed to the tick; they are omitted above for
  that reason. Do not extrapolate a 10,000- or 20,000-message CPU figure from these numbers —
  there is no per-invocation baseline here to scale.

  **What would close it.** Before promoting to 20000, take a reading that reports one
  invocation's own CPU alongside its event type, on the first ticks that pick up a
  >5000-message candidate. The Worker's tail stream is the candidate path — it already delivers
  one `TraceItem` per invocation (`apps/tail-worker/src/index.ts:141`) — but confirm the runtime
  populates a CPU field for `scheduled` events before relying on it. Until such a reading exists,
  treat coordinator CPU at 10,000 as unmeasured.

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

## Follow-ups found during review (not fixed here)

- `sealArchiveTarget` (`apps/api/src/durable-objects/project-data/archive-sharding.ts:1556-1651`)
  computes the same digest **twice** in one DO invocation: once via `computeTerminalVersion`
  (line 1580) and again for `aggregateSha256` (lines 1609-1619), over data that
  `rebuildTargetFts` does not mutate. That is 2x the R2 gunzip/parse/hash work and 4x the
  grouped/tool-payload table scans per seal. Bounded per-call (each DO RPC has its own CPU
  budget) and comfortable at 10000, but it is free margin worth reclaiming before 20000.
  **Confirmed in code and filed separately by the coordinator. Deliberately NOT fixed in this
  PR** — a config change does not get to carry a Durable Object refactor.

### Failure/poison baseline — COLLECTED (pre-ship comparison point)

Measured by the coordinator against production D1, cohort boundary = compact migrations
**created after the 2026-09-18 breaker reset at `1789727663851`**. This is the "current config"
cohort and the same boundary will be re-measured after the 10000 ship:

| Outcome | Rows | Attempts |
| --- | --- | --- |
| published | 42 | 42 total (i.e. one attempt each, no retry ever occurred) |
| frozen / `precopy_refused` | 2 | 1 each (`active_session_state`; `tool_payload_cleanup_incomplete`) |
| failed | 0 | — |
| poisoned | 0 | — |

Three caveats that must travel with these numbers:

1. **The 3 poisoned compact rows in the table overall are NOT in this cohort.** They are
   pre-#2094 R2-deadline incidents (SAM 09-14/15, other projects 09-16) from before the fix and
   the reset. Mixing them into a current-config failure rate would be wrong.
2. **Zero recent failures is a small cohort, not proof of zero risk.** 42 successes does not
   bound the tail, and every one of them ran under the 5000 ceiling.
3. **A `frozen`/`precopy_refused` is a pre-copy eligibility refusal, not a failed chunk copy.**
   The two are different mechanisms with different costs and must not be pooled.

What this does establish for the cost concern above: `attempt_count` is 1 across all 42
publishes, so the retry-and-re-reserve path — the thing that would spend ~44,400 estimated
units per extra attempt at 10000, up to ~16.7% of the daily allowance for a full three-attempt
poison — **has not been exercised at all under the current configuration.** That is reassuring
about frequency and simultaneously means the cost path is untested rather than proven cheap.

## Findings worth keeping

- A 20,000-message session with production-shaped bodies cannot be read in one
  `getMessages` call: the DO RPC size guard truncated at 12,035 rows / 31.4 MB
  (`messages.rpc_size_guard_truncated`). That is rule 50 behaving correctly, but any client
  reading a large archived session must page. Not a regression from this PR.
- `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` is inert as a throughput lever while `_WALL_TIME_MS`
  (10 s) is below one candidate's real duration. The wrangler comment now says so.

---

_Archived 2026-09-23 by the weekly queue reconciliation. This work shipped: it landed on `main` via PR #2109 (`fix: raise archive sweep message budget to 10000 (step 1) (#2109)`). This file is a completion report, not a checklist. Full evidence and method: `tasks/archive/2026-09-23-weekly-queue-reconciliation.md`._
