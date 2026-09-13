# Fix the deadlocked ProjectData archive sweep (selection ceiling > affordability ceiling)

**Status**: active
**SAM task**: `01M2A65Y0FGFHNA5Q1365JSXB9`
**SAM idea**: `01M2A5BCJZR4SAZ78XYEJTNFPR`
**Branch**: `sam/fix-deadlocked-projectdata-archive-5jsxb9`

## Problem

The production ProjectData archive sweep has reclaimed nothing for ~4 days while the root
Durable Object sits at 96.7% of its 10 GB ceiling with ~5 days of headroom. Two independent
ceilings disagree, and candidate selection is largest-first, so every hourly tick
deterministically picks a session it can never afford, is refused, and mutates nothing —
while reporting `succeeded`.

### Verified production evidence (2026-09-12, `sam-prod` D1 + CF Worker settings API)

Deployed Worker vars (read from `GET /accounts/:id/workers/scripts/sam-api-prod/settings`,
**not** the diff — rule 70):

| Var | Deployed | Source |
|---|---|---|
| `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` | `100000` | GitHub `production` Environment override, set 2026-09-08T14:05:09Z |
| `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` | `5000` | `apps/api/wrangler.toml` (**no** Environment override) |
| `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` | `32` | `apps/api/wrangler.toml` |
| `PROJECT_DATA_ARCHIVE_SWEEP_PROJECTS` / `_SESSIONS` | `1` / `1` | `apps/api/wrangler.toml` |
| `PROJECT_DATA_ARCHIVE_COMPACT_ENABLED` | `true` | Environment override |
| `PROJECT_DATA_ARCHIVE_GLOBAL_SWEEP_ENABLED` | `true` | Environment override |
| `PROJECT_DATA_{EVENT_LOG,GROUPED_FTS,TOOL_PAYLOAD}_CLEANUP_ENABLED` | `false` | deliberate — must stay off |

`wrangler.toml` ships `DAILY_WRITE_BUDGET = "250000"`, which would give a 7781-unit ceiling
and no deadlock. The production Environment override pins 100000 and
`sync-wrangler-config.ts` spreads Environment vars over `[vars]`, so the deployed value is
100000. Nobody lowered the selection ceiling when the budget was lowered on 2026-09-08.

State proving the deadlock:

- `project_data_archive_write_budget`: `window_started_at = 1788825600000` =
  **2026-09-08T00:00:00Z**, frozen for 103 h; `reserved_writes = 2216`.
  `reserveArchiveWrites` hard-returns before touching D1, so the window never rolls.
- Last `project_data_archive_migrations.published_at` = **2026-09-08T14:54:56Z** (88 h ago).
  It is the only `r2-gzip-v1` (compact) row ever published: `message_count = 20`,
  reservation 2216 ⇒ **38 write units for 20 messages (1.9x overhead)**.
- `project_data_archive_global_sweep_cadence`: last run 2026-09-12 06:17:03 → 06:17:05,
  `last_status = 'succeeded'`, `last_skip_reason = NULL`, `last_error = NULL`,
  `run_count = 226`. **The sweep reports success while doing nothing.**
- `project_data_storage_telemetry_history` for `01KHRJGANBBWGDY1NZ0KVF0D4J`: monotonic rise
  from the 2026-09-08 trough 9,406,169,088 to 9,670,520,832 (96.705%, `degraded`) —
  +264 MB in 4 days ≈ **66 MB/day**, ~330 MB headroom ≈ **5 days**.
- Top candidate under the deployed ORDER BY is session
  `5f4ac04c-153f-4add-b96b-629bffaf0b2c`, 4994 messages, ended 2026-04-23 — re-picked and
  refused every hour.

### Root cause

1. `selectCandidates` (`apps/api/src/scheduled/project-data-archive-sharding.ts:1084`)
   filters `ss.message_count <= sweepMessageBudget` (5000) and orders
   `message_count DESC ... LIMIT sweepProjects * sweepSessions` (1x1 = 1).
2. `estimateArchiveWrites` (`apps/api/src/project-data-archive/write-budget.ts:45`) =
   `1000 + 32 * (messages + toolPayloads + groupedRows + ceil(ftsBytes/512))`.
3. `reserveArchiveWrites` (`write-budget.ts:90`) hard-returns `false` when
   `estimatedWrites > allowance`, **without touching D1** — so no window rollover either.
4. Affordability ceiling = `floor((100000 - 1000) / 32)` = **3093 units**; selection ceiling
   = **5000 messages**. The 4994-message session estimates ~160,808 ≫ 100,000.
5. The pending loop (`:3193`) calls `reserve()` **before** `createCandidateJournal()` and on
   refusal just `continue`s. With exactly one candidate in the list, `continue` ends the
   tick: no journal row, no location change, no error, `succeeded`, null skip reason.

### Candidate distribution (eligible, `message_count <= 5000`, grace elapsed, root-located)

| bucket | sessions |
|---|---|
| 0–500 | 2261 |
| 501–1500 | 1303 |
| 1501–2000 | 322 |
| 2001–3000 | 386 |
| >3000 | 354 |

**354 unaffordable candidates (7.6%) block 4272 affordable ones.** The hot project alone has
3307 eligible sessions / 3.57 M messages.

## Research findings

1. **The overhead ratio is real and must be budgeted for.** `message_count` counts only raw
   `chat_messages`; the estimate also counts `tool_payload_archives`, `chat_messages_grouped`
   rows, and `ceil(groupedBytes / 512)` FTS units. The one production measurement is
   **1.9x** (20 messages → 38 units). A ceiling derived from `message_count` alone would
   still over-select. → checklist 1, 2.
2. **`applyMessageBudget`'s cumulative budget defeats fall-through.** With `strict = true`
   it `continue`s past candidates that would exceed the cumulative `sweepMessageBudget`. At
   a 2000 cumulative budget and a ~1546 per-candidate ceiling, the packer returns a single
   candidate, so over-fetching alone would not give the refusal anywhere to descend to. The
   cumulative budget must count **journaled** candidates, not considered ones. → checklist 4.
3. **`sweepSessions` must bound fences, not refusals.** A refused candidate is never fenced
   `migrating`, so it must not consume one of the tick's session slots. → checklist 4.
4. **Two refusals, two recovery actions (rule 72).** `estimatedWrites > allowance` can never
   succeed at this allowance (recovery: select a smaller candidate / change the config);
   pool-exhausted means wait for the next UTC window (recovery: nothing, this is normal and
   happens on ~23 of 24 hourly ticks once the daily pool is spent). Today both increment one
   `budgetDeferred` counter, so any alert built on `budgetDeferred` would fire constantly
   under healthy operation. The alert must key on the **unaffordable** category only.
   → checklist 3, 6.
5. **Operator-scoped canaries must keep bypassing the ceiling.** `selectScopedCandidates`
   already bypasses the pre-copy refusal marker when `scope.sessionId` is named ("an operator
   who names the session is asking for exactly that session"). The derived ceiling must
   follow the same principle, and two existing tests
   (`apps/api/tests/workers/project-data-compact-archive.test.ts:222,614`) depend on a
   named-session canary still reaching `reserve()` at `DAILY_WRITE_BUDGET=0`. → checklist 2.
6. **Staging does not reproduce production today.** Staging has **no**
   `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` override, so it runs wrangler.toml's 250000
   (7781-unit ceiling) and cannot deadlock. Lowering wrangler.toml to 100000 makes the
   checked-in value equal the deployed production value, makes staging faithful, and cannot
   raise production spend (production is pinned at 100000 by its override either way).
   → checklist 7.
7. **`estimateArchiveWrites`'s `maxMessages` guard is a second safety net.** It returns
   `Number.MAX_SAFE_INTEGER` when any component exceeds `maxMessages`, catching D1 ↔ DO
   count drift. Passing the affordable **unit** count (not the message ceiling) is the
   purpose-matched bound: anything above it cannot be afforded regardless of overhead.
   → checklist 2.
8. **Throughput reality (reported, not fixed here).** 3093 units/day ≈ ~2000 messages/day at
   a 1.5x overhead. Measured reclaim from the 09-05→09-08 drain was ~500–600 bytes/message
   (849 MB recovered for ~1.77 M messages, before adjusting for concurrent growth), so the
   restored sweep reclaims on the order of **1–1.5 MB/day against ~66 MB/day of growth**.
   The fix ends the deadlock and makes the sweep work, but **the 100000/day budget cannot
   reverse the storage curve.** Raising it is explicitly out of scope (Raphaël rejected the
   ~$100/mo DO bill on 2026-09-08) and is a spend decision for him. → checklist 11.

## Implementation checklist

- [x] 1. `write-budget.ts`: add `archiveAffordableWriteUnits(allowance, factor)` =
      `max(0, floor((allowance - ARCHIVE_WRITE_FIXED_RESERVATION) / max(1, factor)))`, and
      `archiveAffordableMessageCeiling(allowance, factor, overheadPercent)` =
      `floor(units / (1 + overheadPercent/100))`. Export
      `ARCHIVE_DEFAULT_SWEEP_UNIT_OVERHEAD_PERCENT = 100` (2x, matching the 1.9x production
      measurement) as a `DEFAULT_*` constant with an env override (constitution XI).
- [x] 2. Sharding coordinator: resolve `sweepUnitOverheadPercent` and a derived
      `sweepMessageCeiling = min(sweepMessageBudget, archiveAffordableMessageCeiling(...))`.
      Use it as the `message_count <= ?` bind in `selectCandidates`, and in
      `selectScopedCandidates` **only when no explicit `sessionId` is scoped**. Pass
      `archiveAffordableWriteUnits(...)` as `maxMessages` to `archiveSourceEstimateWrites`.
- [x] 3. `reserveArchiveWrites` returns a discriminated outcome
      (`{reserved:true}` | `{reserved:false, reason:'invalid_estimate'|'exceeds_allowance'|'window_exhausted'}`)
      so the caller can distinguish "never affordable" from "pool spent". Update its callers
      and the existing direct-call assertions.
- [x] 4. Fall-through: over-fetch `remaining + fallthroughDepth` candidates for the unscoped
      sweep (new `PROJECT_DATA_ARCHIVE_SWEEP_FALLTHROUGH_DEPTH`, `DEFAULT_* = 4` — lowered from
      8 during review for the round-trip budget); move the
      cumulative message budget and the session-slot bound **into** the pending loop so they
      count journaled candidates only. Extract one `createMessageBudgetPacker` used by both
      the loop and `applyMessageBudget` (no duplicated packing logic — rules 24/59).
- [x] 5. Raise `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS` in `wrangler.toml` from `1` to `4` so a
      single candidate cannot consume an entire tick. **Revised during review to `2`**: the
      fall-through already stops a refused candidate from consuming a tick, and each extra
      fenced session costs ~3 D1 writes plus an unbounded chunk copy against a wall-time gate
      that is only checked BETWEEN candidates. 2 keeps in-flight retry headroom at a fraction
      of the round-trip cost.
- [x] 6. Visibility: split stats into `budgetUnaffordable` / `budgetWindowExhausted`
      (keeping `budgetDeferred` as the total), record `sweepMessageCeiling` and
      `affordableWriteUnits` on the stats, and add D1 migration `0156` adding
      `consecutive_budget_stalls` to `project_data_archive_global_sweep_cadence` via
      `ALTER TABLE ADD COLUMN` (rule 31 — never recreate). `finishGlobalSweepCadence`
      increments it when a tick journaled nothing and the ONLY refusal category was
      `exceeds_allowance`, resets it to 0 otherwise, and reports `partial` (not `succeeded`)
      with a `last_error` naming the recovery action once the count reaches
      `PROJECT_DATA_ARCHIVE_BUDGET_STALL_ALERT_SWEEPS` (`DEFAULT_* = 3`).
- [x] 7. `wrangler.toml`: `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` `5000` → `2000`, and
      `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` `250000` → `100000` so the checked-in value
      equals the deployed production value (rule 70) and staging reproduces production.
- [x] 8. Add the three new vars to `apps/api/src/env.ts`, `apps/api/.env.example`, and
      `apps/www/src/content/docs/docs/reference/configuration.md`; correct the stale
      wrangler-ships annotations in `.env.example` (rule 01, same commit).
- [x] 9. Tests entering through `runProjectDataArchiveSharding` in the Workers pool with a
      realistic candidate mix (rule 62): one session above the affordability ceiling plus
      several below; assert the sweep migrates. Plus: the fall-through control, the
      operator-scoped bypass control, the stall-status test with its reset control, and a
      `reserveArchiveWrites` category test.
- [x] 10. Prove discrimination: revert each fix separately and record which tests go red.
- [ ] 11. Report the throughput gap (finding 8) to Raphaël with numbers in the PR body and
      the completion summary. Do **not** raise the write budget or enable any other
      reclaimer.

## Acceptance criteria

- [x] A sweep whose largest eligible candidate exceeds the affordability ceiling still
      migrates an affordable one in the same tick (test + staging + production evidence).
- [x] The derived ceiling makes `selection ceiling > affordability ceiling` structurally
      impossible at any `DAILY_WRITE_BUDGET`, without a second hand-set number.
- [x] A budget refusal caused by `estimatedWrites > allowance` is distinguishable in stats
      and logs from a spent daily pool.
- [x] N consecutive ticks that journal nothing solely because every candidate was
      unaffordable report a non-`succeeded` cadence status with an actionable `last_error`.
- [x] `PROJECT_DATA_ARCHIVE_DAILY_WRITE_BUDGET` deployed value stays `100000`;
      `EVENT_LOG`/`GROUPED_FTS`/`TOOL_PAYLOAD` cleanup stay `false`.
- [ ] Deployed `PROJECT_DATA_ARCHIVE_SWEEP_MESSAGE_BUDGET` confirmed via the Cloudflare
      Worker settings API after the production deploy (rule 70), not the diff.
- [ ] Production: `project_data_archive_migrations` gains rows with `published_at` after the
      deploy; `project_data_archive_write_budget.window_started_at` advances off
      `2026-09-08T00:00:00Z`; the storage curve is re-measured and reported honestly.

## Review findings addressed (Phase 5)

- **`pendingSlots` was computed but never passed** to `processArchiveMigrationBatch`, so the
  session-slot bound silently fell back to the whole over-fetched list. Found by
  `architecture-reviewer` and independently while tracing consumers. Fixed, the parameter is
  now REQUIRED (no optional-with-silent-fallback, `.claude/rules/73`), and a new test
  (`journals at most sweepSessions candidates...`) was verified to go red without it.
- **Round-trip budget** (`performance-reviewer`, `cloudflare-specialist`): owner stubs are now
  memoised per tick, `sweepFallthroughDepth` default 8 -> 4, `SWEEP_SESSIONS` 4 -> 2. Worst case
  stated in the PR body per `.claude/rules/47`.
- **Stall counter could be reset by a failed read** (`cloudflare-specialist`): the increment,
  threshold comparison and status escalation now happen in one atomic `UPDATE ... RETURNING`.
- **Estimate scan cap was unbounded** (`performance-reviewer`): clamped by
  `ARCHIVE_MAX_ESTIMATE_INVENTORY_UNITS` so it cannot grow with an operator's allowance.
- **`stats.selected` counted the fall-through padding** (`cloudflare-specialist`): now counts
  only what the tick could journal.
- **Stale env docs** (`env-validator`, `doc-sync-validator`): `.claude/skills/env-reference/SKILL.md`
  and the root `.env.example` both stated pre-fix values; both corrected, plus a `/changelog` entry.
- **Missing index on `selectCandidates`** (`cloudflare-specialist`, HIGH): measured instead of
  assumed — production `session_summaries` holds 5,526 rows (5,289 terminal). An hourly
  scan-and-sort of 5.5k rows is negligible and an index would add write cost to every session
  summary write. Not added; measurement recorded in the PR.
- **File size** (`architecture-reviewer`, `constitution-validator`): the file is 3,663 lines,
  already far over the rule-18 ceiling BEFORE this change. Splitting it into 7 modules during an
  urgent production fix would make the diff unreviewable; deferred to
  `tasks/backlog/2026-09-12-split-project-data-archive-sharding-module.md`.

## References

- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/project-data-archive/write-budget.ts`, `.../contract.ts`
- `apps/api/wrangler.toml`
- `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md` (scoped: `apps/api/`)
- `.claude/rules/65-capped-selection-must-rank-and-disclose.md` (scoped: `apps/api/`)
- `.claude/rules/72-error-categories-must-match-the-recovery-action.md` (scoped: `apps/api/`)
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/31-migration-safety.md` (scoped: `apps/api/`)
