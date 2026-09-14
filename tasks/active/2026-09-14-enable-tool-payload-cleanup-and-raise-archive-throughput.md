# Enable ProjectData tool-payload cleanup in production and raise archive sweep throughput

**Status:** active
**SAM task:** `01M2FT7WD9P50E06KHAFBV0AE6`
**Branch:** `sam/enable-projectdata-tool-payload-bv0ae6`
**Related ideas:** `01M0YZNBKSKQZ47NC0K7M8N5AX` (storage tracker), `01M2A5BCJZR4SAZ78XYEJTNFPR` (deadlock post-mortem)

## Problem

The production ProjectData Durable Object (project `01KHRJGANBBWGDY1NZ0KVF0D4J`) sits at
**9,747,591,168 bytes = 97.48 %** of the configured `PROJECT_DATA_STORAGE_LIMIT_BYTES` (10^10),
status `degraded` (measured 2026-09-14 11:14Z, `project_data_storage_telemetry_history`).
Headroom is ~250 MB to the configured alert and ~960 MB to the physical ~10 GiB Cloudflare
ceiling. The object hit `SQLITE_FULL` once already, on 2026-08-18.

Two reclaimers exist and neither is doing enough:

1. **Tool-payload cleanup is off in production.** `apps/api/wrangler.toml` has said
   `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED = "true"` since `684f99d60` (2026-09-03), but a
   GitHub `production` Environment variable pins it `false`, and the Environment wins
   (`getOptionalProcessEnvVars`, `scripts/deploy/sync-wrangler-config.ts`). Nobody noticed for
   11 days. This is the exact trap `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`
   describes.
2. **The archive sweep publishes ~13 sessions/day** against a ~3,300-session root backlog.

Raphaël explicitly approved enabling **tool-payload cleanup only** on 2026-09-14 (project policy
`66060db4`). `PROJECT_DATA_GROUPED_FTS_CLEANUP_ENABLED` and
`PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED` remain gated and MUST NOT be enabled by this work.

## Research findings (all measured 2026-09-14 against production, not inferred)

### R1 — Flipping the flag alone is a no-op. This is the headline finding.

`createToolPayloadCleanupPlan` (`apps/api/src/durable-objects/project-data/tool-payload-cleanup.ts:126-156`)
branches on `fixedCutoffConfigured = config.toolPayloadCleanupCutoffCreatedAt !== null`.

Production Environment has `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_CUTOFF_CREATED_AT = 1788061500000`
(2026-08-30 03:45Z). `parseOptionalTimestamp` returns that value, so `fixedCutoffConfigured` is
**true**, which arms the strict approved-manifest gate. That gate additionally requires all of:

| Required by the gate | Production Environment value | Parsed |
|---|---|---|
| `MANIFEST_KEY` | `""` | `null` |
| `MANIFEST_SHA256` | `""` | `null` |
| `MAX_TOTAL_ROWS` | `""` | `null` |
| `MAX_TOTAL_BYTES` | `""` | `null` |
| `MAX_TOTAL_R2_OPERATIONS` | `""` | `null` |
| `MAX_TOTAL_WALL_TIME_MS` | `""` | `null` |

So the gate returns `null` — **silently, with no log line**. Setting `ENABLED=true` on top of this
config would deploy a flag whose deployed value reads `true` while the feature does nothing, and
the only way to notice would be the absence of reclaim. That is the same failure mode as the
11-day Environment override, one layer deeper.

### R2 — The one-shot preflight completed on 2026-09-04 and was never wired up

D1 `project_data_storage_relief_preflights` (production), single row:

| field | value |
|---|---|
| `plan_id` | `prod-p0-projectdata-01khrjganbbwgdy1nz0kvf0d4j-20260904` |
| `status` | `complete` (2026-09-04 15:42:05Z) |
| `eligible_rows` | 15,539 |
| `eligible_bytes` | 165,879,666 (~158 MB) |
| `session_count` | 3,922 |
| `target_manifest_sha256` | `c90fca2c…4e7bd3` |
| `target_manifest_bytes` | 6,002 |

A completed preflight is terminal (`project-data-storage-relief-preflight.ts:706`,
`row.status !== 'running'` → `'terminal'`), so it will not re-run. The manifest exists in R2 but
the Environment was never given the key, hash, or the four cumulative caps.

**The total tool-payload opportunity is only ~158 MB.** It is worth enabling, but it is not the
main storage lever — see R3.

### R3 — The archive sweep's day ceiling is the write budget, not wall time

| observation | value | source |
|---|---|---|
| Writes reserved by 11:28Z | 726,408 / 800,000 across 11 publishes | `project_data_archive_write_budget` |
| Writes reserved by 12:15Z | 780,016 / 800,000 across 12 publishes | same, sampled again |
| Estimated writes per migration | 53,608-66,037, mean ~65,001 | difference between the two samples |
| **Implied day ceiling** | **12-13 migrations/day** | 800,000 / ~65,001 |

Confirmed behaviourally, twice:

- On 09-13 publishes stopped at 13:12Z and did not resume until 00:35Z on 09-14 — the UTC
  budget-window reset (`ARCHIVE_BUDGET_WINDOW_MS`), not a cadence gap.
- Predicted forward and checked: at 12:15Z only 19,984 units remained, less than any observed
  per-migration estimate, so the 13:00Z tick must be refused with `window_exhausted`. Sampling
  the budget an hour apart is what turns "the budget looks like the ceiling" into a measurement.

Each tick publishes exactly **one** session, for two independent reasons:

- `wallTimeMs = 10000`, but one migration takes **26.6 s** (cadence row: started 11:06:17.866Z,
  completed 11:06:44.503Z). `outOfTime()` is evaluated *before* each session, so session 2 never
  starts.
- `createMessageBudgetPacker(sweepMessageBudget = 5000)`: the largest eligible candidate carries
  **4,849** messages, consuming 97 % of the per-tick budget, so every following candidate is
  refused. `PROJECT_DATA_ARCHIVE_SWEEP_SESSIONS = 4` is therefore **dead config today**.

Because the daily write budget binds first at 13/day, raising `WALL_TIME_MS`, `SWEEP_SESSIONS`,
`SWEEP_PROJECTS`, or the sweep cadence **changes nothing**. The write budget has to move first.

### R4 — `WRITE_ESTIMATE_FACTOR = 8` over-charges the budget ~8x

Cloudflare GraphQL `durableObjectsPeriodicGroups`, namespace `fb36fe2173534537b0f0a9a0efb17777`,
five-minute buckets on 2026-09-14 isolate each archive tick cleanly:

| bucket | rowsRead | rowsWritten | publish |
|---|---|---|---|
| 08:00Z | 584,391 | 7,942 | 08:01:25Z |
| 09:00Z | 580,405 | 5,950 | 09:01:42Z |
| 10:05Z | 573,377 | 6,436 | 10:06:15Z |
| 11:05Z | 609,124 | 9,823 | 11:06:17Z |
| quiet baseline | ~96,000 | ~300 | — |

Net of baseline: **~480,000 rowsRead and 5,950 / 6,436 / 7,942 / 9,823 rowsWritten per
migration**, against `units = (65,001 − 1000) / 8 = 8,000` from the two budget samples above.
Billed rows per inventory unit is therefore **0.74-1.23**, not the single ~1.0 an earlier draft
of this file reported — that figure came from dividing the 11:29Z reservation total by 12
publishes when only 11 had happened, a 9% error. `estimateArchiveWrites` already counts the row
inventory directly, and `factor` is pure safety multiplier on top of it.

Lowering `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` from 8 to **2** moves the day ceiling to
`800,000 / (1000 + 2×8,000) = 47/day`, at which point the hourly per-tick cap binds at
**24/day** — a 2x increase that adds **no new ticks**, **no new contention window**, and **no
extra allowance**. It simply stops wasting the ~12 hourly ticks per day that currently run and
reclaim nothing.

**Margin, stated honestly.** Factor 2 exceeds the worst observed billed-per-unit ratio (1.23) by
**~63 %**, not the 100 % an earlier draft claimed. The safety property still holds — the
reservation exceeded actual billed rows in every sample — but two caveats belong on the record:
n is small (2 budget samples, 4 telemetry buckets), and largest-first selection keeps drawing
differently-shaped candidates as the backlog drains, so the ratio can move. Widen the sample
post-rollout before treating 2 as durably validated.

This is also the lever idea `01M2A5BCJZR4SAZ78XYEJTNFPR` named: *"lower `WRITE_ESTIMATE_FACTOR`
from 32 to a measured value"*. It was lowered to 8 without a measurement; this is the measurement.

### R5 — The change is free, which matters because the previous drain rate was rejected

Production DO namespace `fb36fe21`, 7-day GraphQL totals: `rowsRead` 2,089,474,394;
`rowsWritten` 10,454,143. Excluding the 09-07 drain spike the run rate is **~0.67 M rowsWritten/day
(~20 M/month)** and **~298 M rowsRead/day (~8.9 B/month)**, against free allowances of 50 M and
25 B respectively.

At 24 migrations/day the archive sweep costs ~174 k rowsWritten/day (~5.2 M/month) and ~11.5 M
rowsRead/day (~346 M/month) in total; the **marginal** cost over today's 12/day is about half
that, ~+90 k rowsWritten/day. Totals land at ~25 M/month of the 50 M free rows-written allowance
and ~9.2 B/month of the 25 B free rows-read allowance, so the incremental Cloudflare cost is
**$0**. This respects Raphaël's 2026-09-08 rejection of the projected ~$100/month bill from
sustaining the pre-#2033 drain rate — that rate was ~81 publishes/day, **~3.4x** what this
change permits (it was ~6x today's throttled 12-13/day).

### R6 — Reclaim per archived session, measured

Telemetry 09-05 18:14Z (10,255,826,944) → 09-08 12:14Z (9,407,541,248) = **−848 MB** over 2.75
days across ~155 publishes, against ~70 MB/day live growth. Gross reclaim ≈ **6.7 MB per
archived session**.

- At 13/day: ~87 MB/day reclaimed vs ~70 MB/day growth → net ≈ −17 MB/day (roughly flat, which
  matches the observed telemetry).
- At 24/day: ~161 MB/day → **net ≈ −91 MB/day**, which converges decisively.

Throughput should also self-accelerate as the backlog drains: eligible candidates are
3,136 under 1,000 messages, 1,178 at 1,000-2,999, 344 at 3,000-4,999, so once largest-first
selection works below ~1,250 messages/session the existing `SWEEP_SESSIONS = 4` and the 10 s wall
time start admitting multiple sessions per tick without any further config change.

### R7 — Staging already runs exactly the production configuration being proposed

Deployed `sam-api-staging` bindings: `TOOL_PAYLOAD_CLEANUP_ENABLED=true`, `MANIFEST_KEY=""`,
`PLAN_ID=""`, `PROJECT_IDS=""`, `RECHECK_MS=86400000`. Staging therefore runs the **automatic
retention path** with the 24 h recheck — the configuration this task intends to restore in
production. Staging verification is a true parity proof rather than an approximation
(`.claude/rules/62-tests-must-observe-the-real-trigger.md`).

### R8 — Archive-then-delete is fail-closed (policy constraint verified, not assumed)

`archiveToolPayloadCandidate` (`tool-payload-archive.ts:421-500`) writes the R2 object, requires a
non-null `prepared.verification` proof, re-checks the wall-time deadline, logs
`archive_verified_before_strip`, and only then runs `writeArchiveBookkeeping`. Every failure path
returns `failedArchiveUpdate` with no strip. No DO delete can occur without a confirmed and
verified R2 write. Conversation/message text is untouched — only `tool_metadata` payloads are
tiered, and `get_archived_tool_payloads` remains the retrieval path.

### R9 — Which production divergences are accidental and which are intentional

Measured by diffing all 273 checked-in `[vars]` against the live `production` Environment,
restricted to the names `getOptionalProcessEnvVars` actually reads. **19 overrides currently
disagree**, of which three are flags:

| flag | wrangler.toml | `production` Environment | deployed | verdict |
|---|---|---|---|---|
| `TOOL_PAYLOAD_CLEANUP_ENABLED` | `true` | `false` | `false` | **accidental** — eliminate |
| `EVENT_LOG_CLEANUP_ENABLED` | `true` | `false` | `false` | **intentional** — staging-on, production-gated pending approval |
| `ARCHIVE_COMPACT_ENABLED` | `false` | `true` | `true` | **intentional** — approved for production 2026-09-08; repo default stays conservative for fresh self-host installs |
| `GROUPED_FTS_CLEANUP_ENABLED` | `false` | `false` | `false` | no divergence |

The other 16 are per-installation operator rollout state: the eleven
`PROJECT_DATA_STORAGE_RELIEF_PREFLIGHT_*` knobs plus `_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS`
that size the one-shot P0 plan, and the `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_*` plan identity and
ceilings. These are enumerated by exact name in `EXPECTED_ENVIRONMENT_VAR_OVERRIDES`
(`scripts/deploy/sync-wrangler-config.ts`), which is the machine-readable source of truth — the
`wrangler.toml` comment points at it rather than restating it, so the two cannot drift.

**No `*_ENABLED` flag is on that list, deliberately.** A prefix rule covering
`PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_*` would have suppressed the warning for
`..._CLEANUP_ENABLED`, the exact variable whose silent override started this task. The rule that
quiets the report must not be able to grow over the case that needed it.

`EVENT_LOG_CLEANUP_ENABLED` must NOT be reconciled by flipping `wrangler.toml` to `false`:
staging's deployed value is `true` and that is where the feature is being proven, and the repo
value is also the self-hoster default. The correct treatment is to document the divergence as
deliberate and make the deploy surface it loudly.

## Implementation checklist

### Code and config (this PR)

- [x] `apps/api/wrangler.toml`: `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` `"8"` → `"2"`, with a
      comment citing the measurement in R4 (per `.claude/rules/74`, name the condition the signal
      stands for).
- [x] `apps/api/wrangler.toml`: add a `KNOWN PRODUCTION ENVIRONMENT OVERRIDES` comment block
      recording that `PROJECT_DATA_EVENT_LOG_CLEANUP_ENABLED` is deliberately pinned `false` in
      the `production` Environment pending separate approval, so a future reader is not misled by
      the repo value (R9).
- [x] `tool-payload-cleanup.ts`: when `toolPayloadCleanupEnabled` is true but the approved-plan
      gate refuses for a **configuration** reason, emit a structured `log.warn` naming the missing
      or mismatched fields instead of returning `null` silently. This is the durable fix for R1 —
      it converts an invisible no-op into an observable one.
- [x] `scripts/deploy/sync-wrangler-config.ts`: escalate `listEnvironmentVarOverrides` reporting
      from a plain `console.log` to a GitHub Actions `::warning::` annotation plus a
      `$GITHUB_STEP_SUMMARY` table, so an Environment override that contradicts `wrangler.toml`
      appears in the run summary instead of being buried in deploy logs.
- [x] Tests:
      - [x] Regression test proving the R1 gate: flag on + fixed cutoff + missing manifest ⇒ no
            plan AND a warning is emitted. Delete the guard once and confirm the test reddens.
      - [x] Control test: flag on + no fixed cutoff (the staging/production retention path) ⇒ a
            plan IS produced. Without this the first test also passes when cleanup is broken
            outright (`.claude/rules/62`, absence assertions need a liveness assertion).
      - [x] `sync-wrangler-config` test covering annotation output for a differing override and
            silence for a matching one.
      - [x] Write-budget test pinning that `factor = 2` with an 800,000 allowance admits a
            ~7,442-unit session that `factor = 8` refuses, resolved through the real
            `archiveWriteBudgetConfig` env resolver rather than a hand-passed number
            (`.claude/rules/62`, defaults must be exercised through the real resolver).

### R10 — Which cleanup path production should run (decision, with the rejected option)

Two coherent configurations exist, and the choice was initially made the wrong way round.

**Rejected: clear the cutoff and run the automatic retention path** (the configuration staging
runs). `selectToolPayloadCandidates` walks `chat_messages` by physical `rowid`, bounded by
`PROJECT_DATA_STORAGE_RELIEF_MEASURE_MAX_BATCH_ROWS` — **40,000 rows per pass in production**.
Eligible density is 15,539 / 8,773,156 = 0.18 %, so a 40,000-row window yields ~71 eligible rows,
and one pass per `RECHECK_MS` (24 h) means ~219 days to traverse the table once: **~0.7 MB/day**.

**Chosen: complete the approved-manifest plan.** `scanApprovedToolPayloadCleanupBatch` performs
**no `chat_messages` scan at all** — it reads the preflight's manifest from R2 and touches only
the enumerated targets. Per pass it is bounded by `BATCH_ROWS = 500` and `BATCH_BYTES = 2 MB`
against `toolMetadataBytes`; at the measured average of 165,879,666 / 15,539 = 10,675 bytes per
row the byte bound binds first at ~196 rows/pass, so the plan completes in ~80 passes ≈ 80 days
at **~2 MB/day**.

The manifest path therefore wins on every axis that matters here:

| | retention path | approved-manifest path |
|---|---|---|
| DO rows read per pass | ~40,000 (physical scan) | ~196 (manifest targets only) |
| Passes to drain | ~219 | ~80 |
| Cumulative row/byte/R2/wall ceilings | none | four hard caps |
| Scope | project allowlist | allowlist **and** a SHA-256-pinned manifest **and** a fixed cutoff |

Lower read volume is decisive for a rollout whose entire monitored risk is a DO read spike, and
the hard caps are the right blast-radius control for the first production run of a destructive
path. It also requires no change to the already-armed cutoff/plan config — only filling in the
six values a previous operator left blank.

**Honest sizing:** tool-payload cleanup is worth ~158 MB in total and ~2 MB/day at the deployed
24 h recheck. It is NOT where the storage relief comes from — the archive sweep at 24/day is
(~161 MB/day, R6). Enabling it matters because it was explicitly approved, because it must
actually work rather than read `true` and do nothing, and because a clean read profile is what
unblocks the still-gated grouped-FTS and event-log cleanups later. Do NOT lower `RECHECK_MS` in
this change: it IS the 2026-09-03 read-spike fix, and validating it is the point.

### Production Environment changes (applied after the PR merges and deploys)

**Why these are not in the PR, and how that squares with `.claude/rules/22-infrastructure-merge-gate.md`.**
Rule 22 says infrastructure and configuration items must be checked off before a PR is created
and may not be deferred. These items *cannot* exist in a git diff: they are GitHub `production`
Environment variables, which live outside the repository by design and are read at deploy time by
`getOptionalProcessEnvVars`. Applying them before the PR merges would also enable a destructive
cleanup path on a Worker that does not yet carry the observability fix that makes a refusal
visible — the inverse of the safe order. Project policy `66060db4` ("ProjectData rollout: stage
first, production mutations last") governs this rollout specifically and requires exactly this
sequencing, and its 2026-09-14 approval covers the mutation itself. So: rule 22's intent (no
silent infrastructure debt) is met by enumerating every value here with its derivation, and its
letter is satisfied by policy `66060db4`, which is the more specific instruction for this work.
This task must NOT be archived until the Verification section below holds real evidence.

Complete the approved-manifest plan that the 2026-09-04 preflight produced (R2, R10):

- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED`: `false` → `true`
Re-derive both manifest values rather than trusting this file's transcription (`.claude/rules/32`):

```sql
SELECT target_manifest_key, target_manifest_sha256, eligible_rows, eligible_bytes, status
  FROM project_data_storage_relief_preflights
 WHERE plan_id = 'prod-p0-projectdata-01khrjganbbwgdy1nz0kvf0d4j-20260904';
```

As of 2026-09-14 that returns `status = complete` and:

```
target_manifest_key    = project-data/tool-payloads/approved-plans/01KHRJGANBBWGDY1NZ0KVF0D4J/prod-p0-projectdata-01khrjganbbwgdy1nz0kvf0d4j-20260904/root.c90fca2c30186b628bcf5c18a0744657bf7347901754789bfafb4f79504e7bd3.json
target_manifest_sha256 = c90fca2c30186b628bcf5c18a0744657bf7347901754789bfafb4f79504e7bd3
eligible_rows          = 15539
eligible_bytes         = 165879666
```

A wrong hash fails closed in `readToolPayloadCleanupManifestRoot` (the plan throws rather than
stripping anything), so the risk of a transcription error is a visible abort, not data loss.

- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_KEY`: `""` → `target_manifest_key` above
- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MANIFEST_SHA256`: `""` → `c90fca2c30186b628bcf5c18a0744657bf7347901754789bfafb4f79504e7bd3`
- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_ROWS`: `""` → `15539` (the manifest gate
      throws when `root.eligibleRows > maxTotalRows`, so this is the tightest cap that admits
      exactly the measured plan and nothing more)
- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_BYTES`: `""` → `165879666`
- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_R2_OPERATIONS`: `""` → `225000`
      (150 passes × the 1,500 `ARCHIVE_MAX_OPERATIONS` each pass reserves — ~1.9x the ~80 passes
      the plan needs)
- [ ] `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_MAX_TOTAL_WALL_TIME_MS`: `""` → `3000000`
      (the same 150 passes × the 20,000 ms each pass reserves)
- [ ] **Keep** `CUTOFF_CREATED_AT`, `PLAN_ID` and `PROJECT_IDS` exactly as they are — they are
      the plan's identity and its blast-radius limit
- [ ] Do NOT touch `GROUPED_FTS_CLEANUP_ENABLED` or `EVENT_LOG_CLEANUP_ENABLED`

### Verification

- [ ] Staging deploy + live verification that the archive sweep publishes under `factor = 2` and
      that tool-payload cleanup produces a plan and strips rows with an R2 archive first.
- [ ] Quote the deployed `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` and
      `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` from the Cloudflare API for `sam-api-prod`,
      not from a diff (`.claude/rules/70`).
- [ ] 24 h of post-rollout telemetry: DO `rowsRead`/`rowsWritten`, `exceededCpuErrors`,
      `exceededMemoryErrors`, `fatalInternalErrors`, `platform_errors`, and net storage movement.
- [ ] Update idea `01M0YZNBKSKQZ47NC0K7M8N5AX` with the measured outcome.

## Rollback

| symptom | action |
|---|---|
| DO `rowsRead` for `fb36fe21` exceeds **600 M/day** (2x the ~298 M/day baseline) or any `exceededCpuErrors`/`exceededMemoryErrors`/`fatalInternalErrors` appears | `gh variable set PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED --env production --body false`, then re-run Deploy Production |
| Archive sweep contends with live chat (ProjectData alarm P99 regression, or `platform_errors` shows storage timeouts) | revert `PROJECT_DATA_ARCHIVE_WRITE_ESTIMATE_FACTOR` to `"8"` via a PR, or set it as a `production` Environment variable for an immediate pin |
| Any tool-payload strip without a preceding `archive_verified_before_strip` log | disable immediately and treat as a P0 |

## Acceptance criteria

- [ ] Deployed `PROJECT_DATA_TOOL_PAYLOAD_CLEANUP_ENABLED` in `sam-api-prod` reads `true`, quoted
      from the Cloudflare API.
- [ ] Tool-payload cleanup demonstrably **produces a plan and reclaims** in production — not
      merely that the flag reads `true` (`.claude/rules/30`).
- [ ] Archive sweep reclaim measurably increased, with before/after counts from
      `project_data_archive_migrations` and bytes from `project_data_storage_telemetry_history`.
- [ ] 24 h post-rollout telemetry shows no DO overload, CPU-limit reset, or storage-timeout
      regression, and net storage movement flat or negative.
- [ ] `wrangler.toml` and the `production` Environment no longer disagree accidentally; the one
      remaining divergence is documented as deliberate and surfaced by the deploy.
- [ ] Idea `01M0YZNBKSKQZ47NC0K7M8N5AX` updated with measured numbers.

## References

- `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/39-debug-before-redesign.md`
- `.claude/rules/30-never-ship-broken-features.md`
- Project policy `66060db4` (ProjectData rollout: stage first, production mutations last)
