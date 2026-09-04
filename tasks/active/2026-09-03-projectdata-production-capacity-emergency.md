# ProjectData production capacity emergency

## Problem statement

The production `ProjectData` Durable Object for project
`01KHRJGANBBWGDY1NZ0KVF0D4J` is at imminent `SQLITE_FULL` risk. The latest
available measurement at task start was `9,884,188,672 / 10,000,000,000`
bytes (`98.84188672%`) at `2026-09-03T21:13:42Z`. Subsequent direct measurements
reached `9,908,338,688` bytes at `23:13:44Z`, `9,926,107,136` bytes at
`00:13:45Z`, and `9,950,601,216` bytes (`99.50601216%`) at
`2026-09-04T01:13:48.572Z`. The latest sample reached `9,967,820,800` bytes
(`99.678208%`) at `2026-09-04T02:13:50.204Z`. The configured emergency target
is 90%, so at least `967,820,800` bytes of measured database relief is now required before allowing
for ongoing writes and measurement lag.

This task owns the emergency through implementation, review, staging, merge,
production deployment, an exact human-approved production mutation, and
post-mutation storage/cost/read evaluation. It replaces SAM task
`01M1MJK2KV817XF71M0W2C0QHP`, which failed before startup because its full
devcontainer image could not be pulled (`startedAt=null`, no output PR or
implementation). The successor is SAM task `01M1MJYM0R1BYZ5MDMDVVTCHVS` on
branch `sam/replace-failed-startup-task-vtchvs` in a lightweight isolated VM
workspace.

No destructive production operation is authorized until Raphaël approves an
exact mutation plan. The plan must name project/session/row targets, hard
row/byte/wall-time limits, R2 keys/manifests and verification, failure and
rollback behavior, configuration switches, expected reclaimed bytes,
observation window, and stop conditions. Message text must never be deleted.
Every archive must be verified before source stripping or deletion, and all
uncertain states must fail closed.

## Production baseline

- Latest D1 telemetry re-read points to the `2026-09-04T02:13:50.204Z` direct
  `sql.databaseSize` measurement: `9,967,820,800` bytes, ratio `0.99678208`,
  growth `162,026,818.44` bytes/day, estimated `0.198604` days (about 4.77
  hours) remaining, status `degraded`, cleanup health `running`. This is
  17,219,584 bytes above the prior hourly sample and leaves only 32,179,200
  bytes before the configured limit.
- Last purge was `auto_terminal_event_log_cleanup`; it removed 7 rows and did
  not converge toward the emergency target.
- Production has zero archive-migration, archive-location, and project archive
  circuit-breaker rows for the hot project.
- Production Worker flags have exact archive routing and the global archive
  sweep disabled. CORRECTED 2026-09-04 11:30Z by direct read of the `sam-api-prod`
  Worker settings: `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` is `false`, not
  enabled — every automatic reclaimer (tool-payload, grouped-FTS, event-log,
  archive sharding, global sweep) is off. Only the superadmin manual slice
  (`POST /api/admin/project-data/storage/:projectId/tool-payload-cleanup`, which
  deliberately bypasses the automatic enablement flag) can reclaim anything today,
  and it is capped at 500 rows / 2 MiB / 20 s with a 24 h persisted cooldown.
- The D1 candidate plane contains 3,357 eligible terminal root sessions and
  6,555,879 indexed messages; the largest eligible session has 100,000 messages.
  Candidate discovery does not expose authoritative per-table source bytes.
- For the hot object, the 25-hour Cloudflare window from
  `2026-09-02T21:00Z` through `2026-09-03T21:00Z` recorded 467,894,694 rows
  read (18,715,788/hour average; 45,358,977/hour maximum), 422,976 rows
  written, 718,481,181 microseconds of CPU, one fatal internal error, and no
  periodic exceeded-CPU or exceeded-memory errors. Invocation groups recorded
  78,065 requests and 382 error-status requests.
- Production observability since `2026-09-02T21:00Z` shows no
  `Exceeded the maximum database size` error yet, but does show seven
  Durable Object overload errors and two CPU-reset errors between 15:25 and
  15:42 UTC plus a storage-operation timeout reset on the prior day.

## Research findings

- PR #1978 added pre-wall relief measurement, bounded grouped-FTS cleanup, and
  chunked legacy payload archival, but kept expensive cleanup disabled by
  default and relies on `sql.databaseSize` for reclaim evidence.
- PR #1984 introduced terminal-session archive sharding with source intent,
  target chunk verification, an aggregate seal, immutable R2 recovery chunks,
  a recovery manifest, source-finalize proofs, and exact-routing publication.
- PR #2000 added project circuit breakers, rollout inspection/recovery controls,
  scoped canaries, and fail-closed exact routing.
- PR #2002 fixed the terminal event-log alarm cadence, but the current seven-row
  cleanup is far below observed growth.
- PR #2004 provided the tool-cleanup emergency brake after an expensive scan;
  PR #2005 made candidate selection seekable and restored bounded daily
  cleanup; PR #2008 added a scoped, audited manual cleanup slice and a persisted
  daily gate for global archive sweep work.
- Existing tool-payload cleanup is project-scoped, row/byte/wall bounded,
  seekable, idempotent, and writes R2 before replacing
  `chat_messages.tool_metadata.content`. It never modifies
  `chat_messages.content`. However, a new R2 object is not read back or hashed
  before the SQL transaction strips the source payload. The current 2 MiB/day
  cap also cannot deliver the required emergency relief.
- Existing terminal sharding copies raw `chat_messages` including message text
  and inline metadata into both a target archive shard and immutable R2
  recovery chunks, verifies target chunk hashes, seals an aggregate, writes a
  recovery manifest, and only then deletes session-owned rows from the root.
  Exact reads fail closed during transition. However, newly written R2 chunks
  and manifests are not read back before source deletion.
- The archive coordinator's configured wall-time budget is checked only between
  whole session migrations. `computeTerminalVersion()` materializes all
  session-owned rows and `copySourceChunks()` processes every table/chunk for a
  session in one coordinator pass. A 100,000-message candidate therefore has
  no enforceable per-request wall-time ceiling. Retrying a paused copy would
  currently restart from the first chunk, so merely adding a deadline check
  would not guarantee convergence.
- Existing dry-run candidate selection is D1-only and cannot provide the exact
  authoritative source row/byte inventory needed for the production approval
  gate. A bounded read-only preflight, or an equivalently conservative enforced
  candidate bound with authoritative evidence, is required before a mutation
  can be proposed.
- Prior category evidence suggested tool metadata alone may be smaller than the
  roughly 884 MiB minimum relief requirement. The safe implementation cannot
  assume tool-payload cleanup alone is sufficient; it must measure eligible
  stock and retain terminal sharding as an escalation path.
- All findings above have an implementation or validation item below. No
  production mutation has occurred during research.

## Implementation checklist

- [x] Inspect the failed predecessor and active duplicates; record this task as
      the explicit successor.
- [x] Refresh direct storage, growth, cleanup, candidate, archive-journal,
      circuit-breaker, error, CPU, and rows-read evidence from production.
- [x] Inspect PRs #1978, #1984, #2000, #2002, #2004, #2005, and #2008 plus the
      active ProjectData storage, retention, cleanup, and sharding task records.
- [x] Choose and document the minimum safe composition after measuring
      authoritative eligible tool-payload and terminal-session relief stock.
      Composition is tool-payload-only, conditional on the preflight's average
      payload clearing the 5 KB net-reclaim threshold; below that the documented
      answer is to escalate to terminal-session sharding rather than run this plan.
- [x] Add bounded, resumable, read-only preflight evidence that can produce
      exact project/session/table/row/byte targets without an unbounded object scan.
- [x] Add an explicit per-cron slice cap and aggregate run admission budget so an
      emergency preflight can accelerate without changing the separately leased,
      one-slice default or bypassing the overall row/byte/batch bounds.
- [x] Serialize automatic and manual cleanup through one non-wedging ProjectData
      mutex so R2 awaits cannot interleave stale cumulative reservations or cursor
      writes; prove an overlapping pass cannot duplicate the external archive work.
- [x] Make manifest sizes and all preflight state, measurement, margin, and
      diagnostic bounds configurable and part of immutable plan configuration.
- [x] Require explicit post-write R2 read-back and SHA-256/byte verification
      before the selected tool-payload path strips inline metadata.
- [ ] If terminal sharding is required, make each pass resumable and enforce
      overall row, byte, R2-operation, and wall-time budgets inside a session; the
      next pass must resume after verified committed progress rather than restart,
      and every R2 chunk/root manifest must be read back and verified before source
      session rows are deleted.
- [x] Keep all limits, timeouts, target thresholds, and operator scoping
      environment-configurable, disabled or narrowly scoped by default, and covered
      by a project-level kill switch/circuit breaker.
- [x] Preserve `chat_messages.content` byte-for-byte and prove archived message
      and tool-payload reads work after source cleanup.
- [x] Add discriminating unit and Workers-runtime tests for success, R2
      corruption/missing-readback, timeout/pause/resume, idempotency, candidate
      exhaustion, source-change races, and target/circuit-breaker stop conditions.
- [x] Update Env surfaces, deployment configuration, API/operator docs, and
      task records for every new control or contract.
- [x] Run focused tests, API tests, typecheck, lint, formatting, migration safety,
      config sync, and the relevant full suites.
- [x] Complete all required specialist reviews and address every critical/high
      finding before PR creation/merge.
- [x] Coordinate a successful staging deployment, exercise the real preflight
      and archival path end to end, prove fail-closed behavior, and return staging
      to zero VMs at rest.
- [x] Open the PR, converge CI and CodeRabbit, merge, deploy production, and
      verify the exact deployed version before asking for mutation approval.
      Merged as `831d14e2a` with 17 green checks; D1 `0138` applied to production;
      production Worker verified live with ONLY the read-only preflight enabled.
- [ ] Present the exact production mutation plan and obtain Raphaël's explicit
      approval before any destructive production operation.
- [ ] Execute only the approved bounded plan, verify every archive before source
      deletion, stop at or below 90%, and abort on any uncertainty or stop trigger.
- [ ] Observe storage/growth, archive integrity, errors/overload/CPU, and rows
      read for the approved window; report exact before/after evidence and remaining
      risk rather than stopping at code deployment.

## Recovery ownership and refreshed baseline (2026-09-04)

SAM task `01M1MJYM0R1BYZ5MDMDVVTCHVS` (session `b2f1a155`) was falsely terminalized at
05:17Z by `node_stale_heartbeat` while healthy. That is an infrastructure false kill,
not an implementation failure: its staging cleanup had already succeeded with all ten
payload archives hash-checked and message text preserved, and it had already restored
staging to the six pre-incident controls. Task `01M1P0HMQHAXJ0H4Y7J491ESEF` is its
single replacement owner. No duplicate PR or branch was created.

Refreshed production baseline, read directly from `sam-prod` D1 and the `sam-api-prod`
Worker settings.

**The growth rate is volatile and the window is somewhat shorter than the task brief
assumed.** Hourly `database_size_bytes` for `01KHRJGANBBWGDY1NZ0KVF0D4J` on 2026-09-04:

| Hour (UTC) | Bytes          | Delta    |
| ---------- | -------------- | -------- |
| 05:14      | 9,996,873,728  | —        |
| 06:14      | 10,004,443,136 | +7.6 MB  |
| 07:14      | 10,008,006,656 | +3.6 MB  |
| 08:14      | 10,013,339,648 | +5.3 MB  |
| 09:14      | 10,020,720,640 | +7.4 MB  |
| 10:14      | 10,030,129,152 | +9.4 MB  |
| 11:14      | 10,046,488,576 | +16.4 MB |
| 12:14      | 10,072,158,208 | +25.7 MB |
| 13:14      | 10,080,493,568 | +8.3 MB  |

The hourly rate is volatile, NOT monotonically accelerating: it spiked to 25.7 MB/h at
12:14Z and fell back to 8.3 MB/h in the next hour. Extrapolating from the single steepest
hour briefly suggested "about 26 hours of headroom"; that overstates the urgency and is
corrected here. Use the whole window: across `05:14Z -> 13:14Z` the object grew 83,619,840
bytes, i.e. **10.45 MB/h (251 MB/day)**. The spikes track concurrent agent activity on this
very project — every agent working this incident writes its transcript into this same
Durable Object — which is why agents on this incident must keep their chat output lean, and
why the rate must be re-derived rather than assumed.

- `platform_errors` still has ZERO `Exceeded the maximum database size` rows in seven days
  while the object is above the configured `10^10` limit, so Cloudflare's real per-object
  ceiling is higher — consistent with 10 GiB (`10,737,418,240` bytes).
- Remaining true headroom at 13:14Z is about **656,924,672 bytes**, which at the eight-hour
  average of 10.45 MB/h is roughly **63 hours — about 2.6 days**. A sustained return to the
  12:14Z peak rate would compress that to under 26 hours, so the RATE is the thing to watch,
  not the absolute size.
- Reaching the configured `PROJECT_DATA_STORAGE_EMERGENCY_TARGET_RATIO` of 0.9 now needs at
  least **1,080,493,568 bytes** of measured relief.
- Re-derive both numbers at execution time; do not reuse these.

Merge safety: this PR is non-destructive on deploy. `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED`
stays `false` in production, no `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_*` GitHub
Environment variable is set (so `sync-wrangler-config.ts` falls back to the checked-in
`PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED = "false"`), archive sharding and the
global sweep stay disabled, DO migration `044` is additive `ALTER TABLE ADD COLUMN`
only, and D1 migration `0137` creates a new table.

## Staging evidence on the final head

Staging was free (the other staging owner, task `01M1MZVMF6M8E2FN65986AX5CY`, is cancelled
and its last deploy run was cancelled at 11:17Z). Staging held zero live nodes throughout;
two sleeping workspaces were deliberately left alone because they hold restorable snapshots
belonging to another agent's work (rule 58).

### 1. The preflight is read-only — the property the production step depends on

Deploy `33872266972` (green) ran the scheduled preflight end to end on real Cloudflare
infrastructure: real D1 lease/claim, real Durable Object measurement RPC (now behind the
shared cleanup mutex), real R2 manifest write with post-write read-back verification.

| Field                    | Value                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------ |
| Plan                     | `staging-verify-2014-ddbe0aace`                                                      |
| Project                  | `01KPMZ6Q7NB0PX9J74N4D2MM93`                                                         |
| Status                   | `complete`, `last_error` NULL                                                        |
| Rows examined / eligible | 59 / 10                                                                              |
| Eligible bytes           | 31,313                                                                               |
| Root manifest            | 574 bytes, sha256 `a7142c121176f632e70f11c24d59d12e4988e8274dadea4e0f0ca5bb8af57a22` |

The discriminating check is the re-measurement **after** the plan completed:
`databaseSize 1,040,384`, `eligibleRows 10`, `eligibleBytes 31,313`, `archivedRows 0` —
byte-identical to the pre-preflight measurement. The preflight consumed nothing and
mutated nothing.

### 2. Cursor paging against the real API

Paging the real `relief-measure` endpoint through four cursor pages over 18,954 physical
rows advanced correctly and never returned a null cursor while `hasMore` was true. That is
precisely the defect CodeRabbit found and this branch fixes.

### 3. Exact-manifest cleanup — PASSED, and it produced a go/no-go precondition

Target `01KY2QCEC2FEFDJ1536GGMS3JS`, 17 eligible rows / 8,488 bytes in one session, owned by
the staging smoke user so message text is readable through the normal project API. A
SHA-256 baseline of all 17 target messages was captured before any mutation.

| Check                | Before   | After                    |
| -------------------- | -------- | ------------------------ |
| `eligibleRows`       | 17       | **0**                    |
| `archivedRows`       | 0        | **17**                   |
| `eligibleBytes`      | 8,488    | 0                        |
| Visible message text | baseline | **17/17 byte-identical** |

Every archive row is written only after the R2 object has been read back and byte/SHA-256
verified, so 17 archive rows is 17 verified archives.

Two things this run proved that the tests could not, plus one it exposed:

- The renumbered `0138` migration applied cleanly to a database that had already applied
  the same file under its old `0137` name ("Run Database Migrations With Safety Gates:
  success"). That is the idempotency fix working, not asserted.
- The **fail-closed** half-applied config refused before this, with all 17 rows left
  eligible and untouched — see below.

#### The precondition this exposed: archive bookkeeping is not free

`databaseSize` went **up**, from 978,944 to 987,136 (+8,192), while 8,488 bytes of inline
payload were removed. Reclaiming inline bytes also writes a `tool_payload_archives` row per
payload (R2 key, two hashes, four sizes, verified-object count). On this run that cost
`8,488 + 8,192 = 16,680` bytes across 17 rows, about **981 bytes of bookkeeping per archived
row** — coarse at this scale, since 4 KiB SQLite page granularity dominates a 1 MB object,
but real and directionally right.

The consequence for production is a hard precondition, because net relief is
`gross inline reclaim − (rows × ~1 KB)`:

| Avg payload | Rows for 1.08 GB gross | Bookkeeping | **Net**                                  |
| ----------- | ---------------------- | ----------- | ---------------------------------------- |
| 500 B       | 2,160,987              | 2,120 MB    | **−1,039 MB (worse than doing nothing)** |
| 1 KB        | 1,080,494              | 1,060 MB    | +21 MB                                   |
| 5 KB        | 216,099                | 212 MB      | +869 MB                                  |
| 20 KB       | 54,025                 | 53 MB       | +1,028 MB                                |
| 50 KB       | 21,610                 | 21 MB       | +1,059 MB                                |

**Go/no-go: the preflight's `eligible_bytes / eligible_rows` must be comfortably above
5 KB before the plan is worth executing.** Below roughly 1 KB the operation makes the
object BIGGER. This is why the plan's expected-reclaim figure must be stated as net, and
why the first pass must be checked against the measured `databaseSize` delta before the
remaining passes are allowed to continue.

### 3b. Fail-closed proof (also passed)

Re-proved on the final head because this branch changed relief code. Target
`01KY2QCEC2FEFDJ1536GGMS3JS` — 17 eligible rows / 8,488 bytes in one session, owned by the
staging smoke user so message text can be read back through the normal project API. A
SHA-256 baseline of all 17 target messages' visible text was captured before any mutation.

Deploy `33873876435` shipped a deliberately HALF-APPLIED cleanup configuration — plan id,
allowlist and cutoff set, manifest deliberately absent — as a live test of the fail-closed
guard added for the security review finding. I forced a pass through the superadmin route,
which enters the identical `createToolPayloadCleanupPlan` choke point the alarm uses, so the
system was genuinely asked and "nothing happened" is a positive result rather than an
untested silence (rule 62: an absence assertion needs a liveness assertion beside it).

Result: `skipReason=not_needed`, `terminationReason=not_needed`, `rowsUpdated 0`,
`rowsFailed 0`; all 17 rows still eligible, 0 archived, `databaseSize` unchanged at 978,944,
all 17 message texts byte-identical.

What matters is what did NOT happen. Those rows are older than the 5-day retention window,
so without the new guard the half-applied config would have skipped the strict gate —
including the exact single-project allowlist match — and fallen through to the ordinary
retention path, archiving and stripping them. It refused to build a plan at all instead.

### 3c. What the manual route cost, and the defect that exposed

Running the refuse-proof through the manual route consumed that project's 24-hour manual
cooldown, because the reservation is written BEFORE the pass (it doubles as the overlap
guard). A pass that refused and did nothing still charged the full slot. That is a real
defect for exactly this incident — a one-variable config mistake would cost a day of a
window measured in days — and it is fixed in this branch: the reservation is still taken up
front but released when no plan was built, while a pass that ran keeps its cooldown.

Because the already-written timestamp could not be cleared retroactively, the exact-manifest
proof was completed through the AUTOMATIC alarm path instead, which reads a different
recheck key. That required lowering the staging trigger/target ratios to create storage
pressure on a 987 KB object — the same technique the Workers tests use.

## Exact production mutation plan (AWAITING RAPHAËL'S APPROVAL — nothing below has been executed)

Nothing in this section has been run. The production switches it names are all currently
frozen. Numbers marked `<preflight:…>` are filled in from the read-only preflight's own
verified evidence before the plan is presented; they are not estimates.

### Target

| Field          | Value                                                                                                                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project        | `01KHRJGANBBWGDY1NZ0KVF0D4J` (the SAM dogfooding project)                                                                                                                                     |
| Durable Object | `PROJECT_DATA.idFromName('01KHRJGANBBWGDY1NZ0KVF0D4J')` — one object, no other project is touched                                                                                             |
| Rows           | ONLY `chat_messages` rows with `role='tool'` whose `created_at < 1788061500000` (`2026-08-30T03:45:00Z`) AND that appear in the verified batch manifests, addressed by exact physical `rowid` |
| Column         | ONLY `tool_metadata` — the JSON `content` array inside it is replaced by a stripped marker                                                                                                    |
| Never touched  | `chat_messages.content` (message text), any row not named in a manifest, any other project, any session row                                                                                   |

### What actually executes

The superadmin manual route caps at one pass per 24 h, so it cannot deliver ~1 GB. The
plan therefore arms the **automatic** cleaner, but bound to the approved manifest — which
is a strictly narrower authority than the ordinary retention cleaner, because
`createToolPayloadCleanupPlan` refuses unless _all_ of the following hold together:

1. `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT` is set and not in the future
2. `…_PLAN_ID`, `…_MANIFEST_KEY`, `…_MANIFEST_SHA256` (64 hex) are all present
3. all four `…_MAX_TOTAL_*` ceilings are present
4. `…_PROJECT_IDS` contains **exactly one** id and it equals this DO's own project id
5. a `transactionSync` is available

and `scanApprovedToolPayloadCleanupBatch` then independently re-checks the manifest's own
embedded `planId`, `projectId`, `cutoffCreatedAt`, `eligibleRows` and `eligibleBytes`
against the configured plan on **every** pass. Any disagreement throws before a byte is
written.

### Exact configuration to flip (production GitHub Environment, then Deploy Production)

| Variable                                                    | From            | To                                   | Why                                                                  |
| ----------------------------------------------------------- | --------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED`                 | `false`         | `true`                               | arms the cleaner                                                     |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PLAN_ID`                 | unset           | `<preflight:plan_id>`                | binds to the approved plan                                           |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY`            | unset           | `<preflight:target_manifest_key>`    | the verified R2 root manifest                                        |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256`         | unset           | `<preflight:target_manifest_sha256>` | its SHA-256                                                          |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_PROJECT_IDS`             | unset           | `01KHRJGANBBWGDY1NZ0KVF0D4J`         | single-project allowlist (required, exactly one)                     |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT`       | `1788061500000` | unchanged                            | already correct                                                      |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS`          | unset           | `<preflight:eligible_rows>`          | hard cumulative row ceiling                                          |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES`         | unset           | `<preflight:eligible_bytes>`         | hard cumulative reclaim ceiling                                      |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS` | unset           | `<computed>`                         | hard cumulative R2 ceiling                                           |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS`  | unset           | `<computed>`                         | hard cumulative wall-time ceiling                                    |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TRIGGER_RATIO`           | `0.8`           | `0.95`                               | start condition (object is at ~1.005)                                |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_TARGET_RATIO`            | `0.75`          | `0.90`                               | **stop condition** — see below                                       |
| `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_RECHECK_MS`              | `86400000`      | `60000`                              | pass cadence for the emergency only; reverted afterwards             |
| `PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_ENABLED`             | `true`          | `false`                              | the preflight has served its purpose; stop re-reading the hot object |

`TARGET_RATIO = 0.90` is not advisory. `createToolPayloadCleanupPlan` contains
`if (fixedCutoffConfigured && beforeBytes <= targetBytes) return null;` — once the object
reaches 9,000,000,000 bytes the approved plan refuses to build and cleanup stops on its
own, without anyone watching. That is the primary stop condition and it is the same number
as the acceptance criterion.

`RECHECK_MS = 60000` is a deliberate, time-boxed exception to the at-most-daily storage
cleanup preference. It is justified only by the emergency and is bounded by the four
cumulative ceilings; it MUST be restored to `86400000` when the operation ends.

### Hard limits

- **Per pass**: `BATCH_ROWS` eligible rows, `BATCH_BYTES` of `tool_metadata` read into JS,
  `WALL_TIME_MS` wall clock, `ARCHIVE_MAX_OPERATIONS` R2 operations. Every one is charged
  transactionally _before_ external work and never refunded.
- **Cumulatively across all passes**: the four `MAX_TOTAL_*` ceilings, persisted in DO
  storage. When any is reached the plan refuses to build. There is no path that exceeds
  them.
- **By construction**: only rows named in the verified manifests are eligible.

### Archive and verification

Every row, before its inline payload is replaced:

1. the payload is written to a content-addressed R2 key under
   `project-data/tool-payloads/…{sha256}.json` (chunked for legacy oversized rows);
2. the object is **read back** from R2 and its byte length and SHA-256 compared to what
   was written — a mismatch aborts the row;
3. the archive row (`tool_payload_archives`) records `archive_body_bytes`,
   `archive_body_sha256`, `root_object_bytes`, `root_object_sha256`,
   `verified_object_count` and `source_tool_metadata_sha256`;
4. only then does `UPDATE chat_messages SET tool_metadata = ?` run, and its `WHERE` carries
   the ORIGINAL `tool_metadata` as a compare-and-set — if the row changed since it was
   read, the write loses and the row is deferred, not stripped.

Archived payloads remain readable through the `get_archived_tool_payloads` MCP tool and
the archive read path, which re-verifies the hash on read.

### Failure and rollback behaviour

- Any R2 write, read-back, hash or byte mismatch → the row is left **fully intact** and
  deferred by `ARCHIVE_RETRY_DELAY_MS`. No partial state.
- Any manifest, config, budget or identity uncertainty → the plan refuses to build; nothing
  runs. Fail-closed is the default at every boundary.
- Rollback of the _config_ is a variable revert plus a deploy.
- Rollback of _data_: each stripped payload is recoverable from its verified R2 object.
  Note honestly: there is no automated bulk re-inline path — recovery is per-row through
  the archive read path. This is why read-back verification before stripping is
  non-negotiable, and why message text is never in scope.
- Emergency brake if the object misbehaves during the run: the KV master switches
  (`.claude/rules/55`) stop cron and DO alarms within one cache window without a deploy.

### Expected result

- **Precondition, checked before anything is flipped**: the preflight's
  `eligible_bytes / eligible_rows` must be comfortably above 5 KB. Archiving writes a
  `tool_payload_archives` row per payload, measured on staging at roughly **981 bytes per
  archived row**, so net relief is `gross − (rows × ~1 KB)`. Below about 1 KB average
  payload the operation makes the object BIGGER — on staging, 8,488 gross bytes over 17
  small rows moved `databaseSize` from 978,944 **up** to 987,136. If the production average
  is under 5 KB, do not run this plan; escalate to terminal-session sharding instead.
- Reclaim: `<preflight:eligible_bytes>` GROSS, minus about `<preflight:eligible_rows> × 1 KB`
  of archive bookkeeping. Quote the NET figure for approval. Realised reclaim is the
  `sql.databaseSize` delta; DO SQLite does return freed pages (verified in the workerd
  runtime by `databaseSize drops after deleting rows…`), but the bookkeeping offset is real
  and must not be omitted.
- Resulting usage: from the size measured immediately before the run (`10,072,158,208` at
  12:14Z, still climbing) minus `<preflight:eligible_bytes>`, i.e. a ratio of about
  `<computed>` against the configured `10^10` limit. Because the object is growing at
  10-26 MB/h, the run must be measured against a size read at execution time, not against
  this figure.
- The run self-terminates at `9,000,000,000` bytes even if more candidates remain.

#### If the preflight ends `truncated` rather than `complete`

`truncated` means a ceiling was reached — `MAX_BATCHES`, `MAX_ROWS` or `MAX_BYTES` — before
the candidate set was exhausted. It is NOT an error and the manifest it published is still
internally coherent: it describes exactly the rows that were measured, with the same batch
proofs and hashes, and `scanApprovedToolPayloadCleanupBatch` validates it identically.

A truncated plan is therefore executable. It simply reclaims less than the full eligible
stock, so the arithmetic changes rather than the safety:

- The ceilings still come from the row, so the approved authority still cannot exceed what
  was actually measured.
- The expected net reclaim is computed from the truncated `eligible_bytes`, not from an
  estimate of the whole stock.
- If that net does not bring the object under 9,000,000,000 bytes, say so explicitly when
  presenting the plan. The options are then a second preflight plan under a new plan id for
  the next tranche, or escalation to terminal-session sharding — not raising the ceilings by
  hand, which would break the "authority equals evidence" property this design depends on.

`MAX_BYTES` is deliberately set at 1,250,000,000, slightly above the ~1.08 GB currently
needed, so a single tranche should suffice if the average payload clears the threshold.

## Observation window and stop conditions

Watch for **6 hours** after the first pass, then a final check at **24 hours**:

- `project_data_storage_telemetry` for `01KHRJGANBBWGDY1NZ0KVF0D4J` every hour: size must
  fall monotonically and stop at or above 9e9.
- `platform_errors` for `Exceeded the maximum database size`, Durable Object overload,
  storage-operation-timeout resets, and any `alarm.storage_safety_failed`.
- Cloudflare DO analytics: rows read/written and CPU for the hot object must not exceed the
  pre-operation baseline (~18.7M rows read/hour average) by more than 2x.
- `tool_payload_archives` row count must increase by exactly the number of stripped rows.
- A sampled read of an archived payload through the MCP retrieval tool must return the
  original content.

**Check the first pass before allowing the rest.** After the first pass completes, compare
the measured `databaseSize` delta against that pass's reported `rowsUpdated`. If the object
did not shrink by at least half the pass's gross projected reclaim, stop — the bookkeeping
overhead is dominating and the remaining passes will not converge.

**Abort immediately** (revert `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` to `false`, or
pull the KV alarm brake if faster) if any of: a single `Exceeded the maximum database size`
error appears; DO overload or CPU-reset errors appear; rows-read for the object more than
doubles against baseline; `rowsFailed` is non-zero on two consecutive passes; the measured
size does not fall after three consecutive passes; or any archive read-back failure is
logged.

### Contingency if the object hits the wall before approval

If `Exceeded the maximum database size` starts appearing before Raphaël approves, the
fastest safe relief that is already merged and needs no further approval is the
**superadmin manual cleanup route**
(`POST /api/admin/project-data/storage/01KHRJGANBBWGDY1NZ0KVF0D4J/tool-payload-cleanup`),
which bypasses the automatic enablement flag, is bounded at 500 rows / 2 MiB / 20 s, and
uses the identical archive-then-verify-then-strip path. It reclaims only ~2 MiB per 24 h
under current settings, so it is a stopgap that keeps writes alive rather than a fix, and
it still requires a human with superadmin credentials to call it. The genuinely fast
contingency remains this plan; the contingency for the _contingency_ is the 2026-08-18
precedent — a manual operator purge — which has no archive guarantee and would lose tool
payloads permanently.

## Post-mortem (defects found in review, fixed before any production use)

**What broke.** Two latent defects in the relief path, both caught by review before the
code ran against production data.

1. `measureToolPayloadSlice` assigned its resume cursor _after_ the row-limit and
   wall-time break checks. A slice that exhausted its budget before advancing returned
   `hasMore: true` with `nextCursor: null`; the preflight then persisted
   `cursor_json = null` and the next slice restarted at the lowest rowid. Consequences:
   `rows_examined` / `eligible_rows` / `eligible_bytes` accumulate the same physical rows
   twice — inflating the exact reclaim evidence a human is asked to approve — and duplicate
   `rowId` targets appear across batch manifests, which the per-batch ordering check cannot
   detect because it only orders within one batch.
2. `runProjectDataManualToolPayloadCleanup` compared a stored idempotency fingerprint
   against `compatibleLegacyFingerprint`, which is `null` precisely when an exact cutoff is
   configured. A missing stored fingerprint is also `null`, so `null !== null` was false and
   a reused key was accepted as compatible — it could replay an unrelated result or start
   cleanup with different inputs after the cooldown expired.

Review additionally found that the destructive path's fail-closed guards were largely
untested in the configuration that arms them: four of the five disjuncts of the
approved-manifest scope check (`planId`, `projectId`, `cutoffCreatedAt`, `eligibleRows`)
had no test, and the structural manifest parsers had no test file at all. Separately, the
approved-manifest branch could be entered without the fixed-cutoff gate — and therefore
without the exact single-project allowlist match — if `CUTOFF_CREATED_AT` alone was dropped
from an otherwise complete plan config.

**Class of bug.** A fail-closed guard whose falsifying case is unreachable in the
configuration the tests use. The guard exists, reads correctly, and never executes; line
coverage counts it because the enclosing branch runs while the disjunct inside it never
evaluates true. This is the configuration-level sibling of rule 53's
liveness-used-as-idleness trap.

**Why it wasn't caught.** The suite exercised the ordinary retention configuration
thoroughly and the exact-plan configuration only on its happy path. Nothing forced a test
per disjunct, and the one manifest-corruption test flipped bytes — which the SHA-256 gate
catches before any structural assertion runs, so the parsers were never reached.

**Process fix (this PR).** `.claude/rules/69-emergency-config-paths-need-their-own-coverage.md`.

## Acceptance criteria

- [ ] Production `sql.databaseSize` for `01KHRJGANBBWGDY1NZ0KVF0D4J` is at or
      below 9,000,000,000 bytes after the approved operation.
- [ ] No message text is deleted; sampled and boundary session reads remain
      byte-equivalent across any ownership transition.
- [ ] Every removed inline tool payload and every deleted root session row has a
      verified R2 recovery object or manifest and hash evidence recorded before the
      source mutation.
- [ ] Destructive work cannot exceed the approved project/session set or the
      configured rows, bytes, R2 operations, and wall time, and can be stopped by a
      scoped circuit breaker/kill switch.
- [ ] Partial work and failures retain a readable authoritative source, persist
      resumable progress, and never publish an unverified archive owner.
- [ ] Staging validates the production-like path and has zero VMs at rest after
      verification.
- [ ] CI, specialist reviews, CodeRabbit, merge, deployment, and exact deployed
      commit are all recorded.
- [ ] The post-operation observation window shows storage relief plus stable or
      improved read cost and no new capacity, overload, CPU, or archive-integrity
      incident attributable to the operation.

## References

- `tasks/active/2026-08-31-projectdata-terminal-archive-sharding.md`
- `tasks/active/2026-09-01-archive-sharding-rollout-controls.md`
- `tasks/active/2026-09-02-manual-projectdata-cleanup-and-sharding-cadence.md`
- `tasks/active/2026-08-26-projectdata-tool-payload-r2-archival.md`
- `tasks/active/2026-08-27-projectdata-retention-convergence.md`
- `tasks/active/2026-08-31-projectdata-pre-wall-storage-relief.md`
- `tasks/archive/2026-07-02-institutionalize-projectdata-wall-time-prevention.md`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/services/project-data-archive-rollout-controls.ts`
- `apps/api/src/durable-objects/project-data/tool-payload-manual-cleanup.ts`
- `apps/api/wrangler.toml`
- `.claude/rules/09-task-tracking.md`
- `.claude/rules/13-staging-verification.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
