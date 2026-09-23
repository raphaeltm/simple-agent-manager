# ProjectData archive copy reliability — Slice A

**SAM task:** `01M35R3TXJNB8HMHAF988R7502`

**Parent implementation:** task `01M32TCPHE7D45WRJ9K6TC49JM` on branch
`sam/implement-reliable-projectdata-archiving-tc49jm` at `982e48ccf`. This task carves the
archive-copy reliability portion from that branch. The parent branch and its task file remain intact
for later Slice B and Slice C work.

## Problem

The production SAM ProjectData archive drain is stalled because a large compact archive migration
repeatedly exceeds the R2 deadline. Retries restart each table from the beginning, repeating source
reads, decompression, hashing, and uploads until the migration is poisoned. The root ProjectData
object is already over its configured storage limit, so the copy path must durably resume verified
work while preserving the existing archive format, reader behavior, and deletion safety proofs.

## Research findings

- The complete implementation is available on the parent branch, but it also contains exhaustive
  history search and bounded root-history indexing. This PR must contain only the archive-copy slice.
- D1 migration `0171_project_data_archive_copy_checkpoints.sql` adds coordinator checkpoints. DO
  migration `058-archive-copy-receipts-and-search-coverage` adds target receipt and coverage state;
  its content must stay identical because staging already applied it at `a85244d4c`.
- Copy state spans the scheduled coordinator, ProjectData source/target RPCs, compact R2 helpers,
  hashing, and minimal verified-target visibility in `services/project-data.ts`.
- `archive-sharding.ts` is already over 500 lines and the carve increases it substantially. Preserve
  the reviewed parent implementation in this urgent carve and document the scoped file-size
  exception; structural decomposition would make this a rewrite and risk diverging from the already
  staged migration/state-machine implementation.
- Staging must use one pinned candidate and real R2. It must prove checkpoint resume without prefix
  re-export, deletion refusal when transcript/index proof is absent, successful sweep completion,
  and that already-applied DO migration 058 is a no-op.
- Production archive breaker mutation and production data cleanup are explicitly outside this task.

## Implementation checklist

### Durable copy and bounded work

- [x] Add additive D1 migration 0171 and matching schema for per-table archive copy checkpoints.
- [x] Add only DO migration 058 with content identical to staging SHA `a85244d4c`; exclude migration 059.
- [x] Add bounded, content-free migration progress evidence for phase, table, ordinal, byte counts,
      operation outcome/duration, lease epoch, and request correlation.
- [x] Freeze retry layout fields while preserving in-flight and legacy migration layouts/readers.
- [x] Advance durable per-table checkpoints only after verified target receipts; reconcile receipts
      ahead of checkpoints and reject missing or incompatible receipts.
- [x] Resume at the verified cursor/ordinal with immutable keys and hashes across reset boundaries.
- [x] Use byte-identical incremental hashing, avoid duplicate attempt-local reads/decompression, and
      retain retry-time corruption and final pre-delete verification.
- [x] Bound every export page by canonical bytes with a finite integrity-preserving oversized-row path.
- [x] Classify timeout stage/cancellation and prevent retry from racing duplicate provider I/O.
- [x] Keep source finalization bounded and atomic.

### Publication and deletion safety

- [x] Copy and version the materialization watermark/index-state anchor contract.
- [x] Build and verify complete destination index coverage before sealing or source deletion.
- [x] Refuse deletion when transcript or index proof is missing, inconsistent, corrupt, or unavailable.
- [x] Add bounded idempotent repair for incomplete published compact archives without refilling root.
- [x] Keep source-or-verified-target visibility during migration/publication/repair with stable dedupe.
- [x] Limit `services/project-data.ts` changes to compile-correct verified-target visibility; defer new
      search semantics, continuation, owner inventory/coverage, environment variables, and MCP changes.

### Tests and gates

- [x] Add focused unit/workerd coverage for production-shaped byte bounds, oversized rows, receipts,
      checkpoints, resume boundaries, repair, hashing, atomic rollback, and proof-gated deletion.
- [x] Run focused tests, `pnpm check:fast`, typecheck, full API tests,
      `pnpm quality:migration-safety`, and `pnpm quality:do-migration-safety`.
- [x] Complete Cloudflare, security, test, constitution, and task-completion specialist reviews and
      record evidence in the PR.
- [x] Deploy one pinned SHA to shared staging after checking active runs/agents; verify real-R2 resume,
      deletion refusal, completed sweep, and migration 058 no-op; clean up only created resources.
- [ ] Create the PR, pass CI and iterative CodeRabbit review, merge, monitor production deployment,
      and verify the production Worker deployment changed.

## Staging evidence (2026-09-23)

- Pinned candidate: `be623ac8c42e00c527117c4f5d911fb18884e313`. Baseline Deploy Staging
  run `35806098986` succeeded, including smoke tests. Its migration step reported no pending D1
  migrations, confirming D1 0171 and DO 058 were already applied and replayed as no-ops.
- The first temporary-grace redeploy, run `35807501322`, failed only in Cloudflare Containers
  rollout with `Error rolling out application "sam-api-staging-vmagentcontainer-staging": Request
  timeout`. Retry `35808592724` succeeded, including smoke tests. Direct Worker settings readback
  confirmed the temporary binding was deployed as `PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS="0"`.
- The runtime parser requires the configured grace to be at least 1 ms, so the deployed `"0"`
  value fell back to seven days; a scoped dry run selected no recent session. The temporary override
  was corrected to `"1"`, and pinned run `35809727532` succeeded, including smoke tests. Direct
  Worker settings readback confirmed `"1"`, and the same dry run then selected the 1,575-message
  session `chat_01M2EKF913P69CT6FVP4NRHTM4` in project `01KJNR9R3TEN3KX1ETE33852R8`.
- The live-R2 migration was `520a80e4-9d0e-4804-97b6-69b5ac35a40a`. An intentional 25-second
  client timeout interrupted attempt 2 after 16 verified `chat_messages` chunks: D1 showed
  `next_ordinal=16`, 160 copied rows, 42,705 copied bytes, an immutable last-chunk SHA-256, and the
  next operation only in `export_commit:started`. While target aggregate/index proof and the R2
  recovery manifest were absent, `source_deleted_at` and `published_at` remained null.
- Attempt 3 reclaimed the expired lease and resumed the same frozen 10-row/65,536-byte layout.
  Its result reported 152 chunks and 1,501 rows copied. Final checkpoints contained 168 chunks and
  1,661 rows, so the 16 verified chunks and 160 rows from attempt 2 were not copied again. R2 object
  timestamps independently preserved the prefix: `chat_messages/0.json` and `/15.json` remained at
  `02:39:50Z` and `02:40:10Z`, before the resume began, while `/157.json` was created at `02:48:46Z`.
- The scoped sweep completed with `migrated=1`, `failed=0`, and `poisoned=0`. D1 then showed all
  checkpoints complete, a target aggregate hash, the R2 manifest key, `state=published`, and exact
  archive-shard routing. Source deletion occurred only after those transcript/index/recovery proofs
  existed. Two additional scoped probes were refused before copy (`active_session_state` and
  `message_comments_present`); both retained their source, had no target/deletion/publication proof,
  and were returned to root with the operator-abandon cleanup control.
- The temporary GitHub staging Environment override was deleted. Pinned restoration run
  `35812013902` succeeded, including smoke tests, and direct Worker settings readback confirmed
  `PROJECT_DATA_ARCHIVE_SESSION_GRACE_MS="604800000"`, matching the checked-in seven-day default.
  The Environment override list is empty, and staging remained at zero live VMs throughout.

## Post-rebase validation (2026-09-23)

Rebased cleanly onto `origin/main` at `c9deee440`, then passed:

- `pnpm check:fast`
- `pnpm typecheck` (19/19 Turbo tasks)
- focused API archive/migration tests (5 files, 143 tests)
- focused workerd compact-archive tests (1 file, 7 tests)
- full API tests (748 files, 10,232 tests)
- `pnpm quality:migration-safety`
- `pnpm quality:do-migration-safety`

## Acceptance criteria

1. A reset or timeout at any copy boundary resumes from verified durable progress with the same
   immutable v1 chunk layout; verified prefixes are not exported, uploaded, decompressed, or committed
   again.
2. Peak working data is byte bounded for every copied table, including a finite integrity-preserving
   oversized-row path. Missing/tampered chunks and incompatible checkpoints block deletion.
3. Source removal occurs only after exact transcript/tool parity and verified complete destination
   search coverage. Partial/pruned sessions remain visible through repair and publication races.
4. Production-shaped tests cover the scoped scale/fault matrix and every required repository gate
   passes.
5. Staging proves the pinned candidate against real R2, and the final PR clears specialist review,
   CI, and CodeRabbit before merge. Production deployment is monitored and read-only verification
   confirms the Worker changed.

## Explicit deferrals

- **Slice B:** exhaustive project-wide history search, signed continuation, owner inventory and
  coverage disclosure, six `PROJECT_DATA_ARCHIVE_SEARCH_*` variables and deployment plumbing,
  MCP/session-search contracts, search tests, and documentation.
- **Slice C:** DO migration 059, bounded root history indexing, `materialization.ts`, `messages.ts`,
  row schemas, grouped rebuild backup, and incremental-materialization/storage-safety tests.
- Canonical complete-message storage, transient-fragment disposal, tool-output migration, and
  session-owned primary storage remain in idea `01M0YZNBKSKQZ47NC0K7M8N5AX`.

## Safety

- Do not close the production breaker, delete/copy back production data, enable gated cleaners, or
  add a destructive migration.
- Preserve existing in-flight and legacy migration layouts and reader semantics.
- Stop with concrete dependency evidence if Slice A cannot be separated without expanding scope.

## References

- Parent task: `tasks/active/2026-09-21-projectdata-archive-search-reliability.md` on the parent branch
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/project-data-archive/compact-r2.ts`
- `apps/api/.claude/rules/31-migration-safety.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/13-staging-verification.md`
