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

- [ ] Add additive D1 migration 0171 and matching schema for per-table archive copy checkpoints.
- [ ] Add only DO migration 058 with content identical to the parent branch; exclude migration 059.
- [ ] Add bounded, content-free migration progress evidence for phase, table, ordinal, byte counts,
      operation outcome/duration, lease epoch, and request correlation.
- [ ] Freeze retry layout fields while preserving in-flight and legacy migration layouts/readers.
- [ ] Advance durable per-table checkpoints only after verified target receipts; reconcile receipts
      ahead of checkpoints and reject missing or incompatible receipts.
- [ ] Resume at the verified cursor/ordinal with immutable keys and hashes across reset boundaries.
- [ ] Use byte-identical incremental hashing, avoid duplicate attempt-local reads/decompression, and
      retain retry-time corruption and final pre-delete verification.
- [ ] Bound every export page by canonical bytes with a finite integrity-preserving oversized-row path.
- [ ] Classify timeout stage/cancellation and prevent retry from racing duplicate provider I/O.
- [ ] Keep source finalization bounded and atomic.

### Publication and deletion safety

- [ ] Copy and version the materialization watermark/index-state anchor contract.
- [ ] Build and verify complete destination index coverage before sealing or source deletion.
- [ ] Refuse deletion when transcript or index proof is missing, inconsistent, corrupt, or unavailable.
- [ ] Add bounded idempotent repair for incomplete published compact archives without refilling root.
- [ ] Keep source-or-verified-target visibility during migration/publication/repair with stable dedupe.
- [ ] Limit `services/project-data.ts` changes to compile-correct verified-target visibility; defer new
      search semantics, continuation, owner inventory/coverage, environment variables, and MCP changes.

### Tests and gates

- [ ] Add focused unit/workerd coverage for production-shaped byte bounds, oversized rows, receipts,
      checkpoints, resume boundaries, repair, hashing, atomic rollback, and proof-gated deletion.
- [ ] Run focused tests, `pnpm check:fast`, typecheck, full API tests,
      `pnpm quality:migration-safety`, and `pnpm quality:do-migration-safety`.
- [ ] Complete Cloudflare, security, test, constitution, and task-completion specialist reviews and
      record evidence in the PR.
- [ ] Deploy one pinned SHA to shared staging after checking active runs/agents; verify real-R2 resume,
      deletion refusal, completed sweep, and migration 058 no-op; clean up only created resources.
- [ ] Create the PR, pass CI and iterative CodeRabbit review, merge, monitor production deployment,
      and verify the production Worker deployment changed.

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
