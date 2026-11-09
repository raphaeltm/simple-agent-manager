# Capacity pool publication stalls VM placement for days (200-row per-pass cap)

## Problem

Production, 2026-11-09: the user default pool `cap-pool-default:user:4bw1FJlXCOgSGq0TsQgpiMAhQKjGOSXx`
has been `migration_state='pending'` since the daily scheduled reconcile at 10:20:53Z. No VM task
has been placed on it since (the last placement, 09:01Z, used pool revision 22; the pool is now at
revision 24).

`defaultPoolEffectiveState()` (`apps/api/src/services/default-capacity-pool-summaries.ts`) maps
`migrationState !== 'complete'` to `migration-pending`, and `buildCapacityPoolSelection`
(`apps/api/src/services/placement-resolver-capacity.ts`) returns **zero candidates** for any pool
whose effective state is not `configured-ready`. So the whole pool, including fully published
Hetzner sources, is unplaceable while any one source's publication is incomplete.

`ensureCandidatesForSource()` (`default-capacity-pool-candidates-publication.ts`) publishes at most
`DEFAULT_CAPACITY_POOL_CANDIDATE_PUBLISH_BATCH_SIZE = 200` rows per invocation and then returns.
There is no continuation in the same pass. The user's GCP source (default 14 machine types x every
Google zone) resolves to ~1,000 candidate rows, so a changed GCP catalog needs 5 refreshes to
complete. Refreshes run once per 24 h (`runScheduledCapacityPoolReconciliation`) or when the user
touches the pool in Settings. Every membership edit (`PATCH /api/capacity-pools/defaults`) runs an
ensure first and changes candidate `status`, which is part of the publication digest, so the next
refresh restarts the cursor at 0.

## Production evidence (sam-prod D1, 2026-11-09 ~12:30Z)

- `capacity_pools`: user pool `migration_state='pending'`, `revision=24`,
  `last_reconciled_at=2026-11-09T12:14:31Z`. Installation and other user pools `complete`.
- `platform_settings` cursor
  `capacityPools.candidatePublication.v1:<pool>:cap-source-default:user:01M6NJE8E4M666WGGAWEAVPVYZ`
  = `{"published":400,"complete":false}`; Hetzner source cursors `complete:true` (236 rows each).
- GCP source: 1,000 candidate rows (500 offerings x 2 workload roles), 114 active.
- `capacityPools.scheduledReconciliation.lastRun.v1` = `2026-11-09T10:20:53Z` (24 h interval).
- No VM `tasks.placement_explanation_json` after 09:01Z.

## Root cause

A count bound (200 rows) used as the whole per-pass work budget, with refreshes that are rare
(daily or user-triggered). `.claude/rules/81-work-bounds-must-state-throughput.md` describes this
exact class: throughput was 200 rows per day at the outer probable limit, so a 1,000-row catalog
took up to 5 days, and the readiness gate turned every in-flight republication into a full-pool
placement outage.

Platform check: a D1 `batch()` counts as one query against the per-invocation query limit, and each
batch call must resolve within 30 s (https://developers.cloudflare.com/d1/platform/limits/). Looping
several 200-statement batches in one pass is within platform limits; 200 stays as the chunk size.

## Not a re-architecture

The fenced, cursor-resumable publication design is sound. The fix keeps it and adds the missing
deadline-bounded loop (rule 81 requirement 2).

## Implementation Checklist

- [ ] Add admin setting `capacityPools.candidatePublishBudgetMs` (registry, default + range).
- [ ] `ensureCandidatesForSource`: publish successive batches until the catalog is complete, a
      fenced write fails (a newer publisher owns the rest), or the per-pass budget elapses. Persist
      the cursor after each batch so a mid-pass failure resumes.
- [ ] Keep already-complete, unchanged catalogs at one batch per pass (timestamp round-robin is
      unchanged; no extra writes for steady-state refreshes).
- [ ] `ensureDefaultPoolForCredentialSeeds`: resolve the budget once per pass (option override, then
      admin setting when `env` is present, then default); share one deadline across sources.
- [ ] Budget `0` keeps the legacy one-batch-per-pass behavior; update existing multi-pass resumption
      tests to pass it explicitly so they keep testing resumption.
- [ ] Tests: a catalog larger than every count in the path completes in ONE pass through the real
      entry point (`ensureDefaultCapacityPoolsForExistingCredentials`) on a real SQL engine, and
      the pool reads `configured-ready` with placement candidates afterwards.
- [ ] Tests: deadline expiry leaves a resumable cursor and the next pass completes; fenced failure
      stops the loop without counting rejected rows.
- [ ] Prove the main test discriminating against the pre-fix single-batch behavior.
- [ ] Docs: admin settings guide entry if settings are documented there.

## Acceptance Criteria

- [ ] A 1,000+ row catalog publishes completely in a single refresh with default settings.
- [ ] A pool whose catalog changed is `configured-ready` after one refresh (not N refreshes).
- [ ] Budget exhaustion persists progress and the next pass resumes (no restart at 0).
- [ ] Steady-state refresh of an unchanged, complete catalog writes no more than before.
- [ ] Production: after deploy, the affected user pool returns to `migration_state='complete'`
      on its next refresh and VM placement resumes.

## Throughput at the outer probable limit (rule 81)

- Chunk: 200 rows per D1 batch. Default budget: 20 s per pass.
- Default GCP catalog (14 types): ~500 offerings x 2 roles = ~1,000 rows = 5 batches, one pass.
- Outer probable limit: `gcpCatalog.machineTypes` max 100 types (~36 zones per type observed) ~
  3,600 offerings x 2 = ~7,200 rows = 36 batches. If one batch takes ~0.5 s that fits one pass; if
  the budget is hit, the cursor persists and the next pass continues.

## Deferred

- The readiness gate still treats "a source is mid-republication" as "pool has no candidates"
  (`.claude/rules/74` proxy-signal class). With this fix a republication completes in one pass for
  realistic catalogs, so the gate is only visible past the budget. Tracked in
  `tasks/backlog/2026-11-09-capacity-pool-readiness-gate-during-republication.md`.

## References

- `.claude/rules/81-work-bounds-must-state-throughput.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `.claude/rules/39-debug-before-redesign.md`
- `apps/api/src/services/default-capacity-pool-candidates-publication.ts`
- `apps/api/src/services/default-capacity-pools-ensure.ts`
