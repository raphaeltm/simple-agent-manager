# Reliable ProjectData archiving and complete history search

## Problem

The SAM project's root `ProjectData` Durable Object is again within megabytes of its configured
10 GB safety threshold. Compact archive migration can repeat expensive R2 reads and whole-prefix
copy work after resets, and a valid 8,962-row migration exhausted three attempts on R2 deadlines.
Project-wide history search queries only a fixed owner prefix and can report success even when
retained text is absent from the destination index or an FTS query failed.

The accepted design is idea `01M0YZNBKSKQZ47NC0K7M8N5AX`: harden the deployed archive format and
make existing archive owners completely searchable, then use measured latency and billed usage to
decide whether a separate search projection is justified. Canonical-message storage and moving live
session ownership remain separate follow-ups.

## Reconciled evidence

- Current branch and `origin/main` started at `ed1b3697e` on 2026-09-21. The bounded open-PR scan
  found no overlapping ProjectData archive/search implementation.
- PRs #2094 (per-chunk R2 timeout), #2109 (10k sweep budget), and #2117 (incremental
  materialization) are on main and are inputs to this work, not work to repeat.
- At 2026-09-21 20:35:03 UTC, read-only production D1 reported root
  `database_size_bytes=9,992,175,616`, `limit_bytes=10,000,000,000`, usage `99.92175616%`, and a
  stored positive growth estimate of `25,880,008 B/day`. The latest history row was 16:26 UTC, so
  current and history timestamps must remain distinct.
- The archive breaker reopened at 16:17:11 UTC with `attempts_exhausted:Error`. Migration
  `67927ce6-e717-48a4-bca0-0da76b20db39` is now poisoned after attempt 3 with `Compact archive R2
deadline exceeded`. Production still has 237 published sessions across 111 archive owners, 13
  frozen migrations, 2 poisoned migrations, and 11 root locations.
- The accepted-plan trace found up to five raw-chunk read/decompress cycles on a fresh compact path,
  while `copySourceChunks()` restarts each table at cursor null and ordinal zero after failure.
  Exact timeout phase is still unproven; phase/chunk evidence must identify it without logging text.
- Compact raw chunks cap canonical source rows at 2 MiB, while grouped/tool copy pages are primarily
  row bounded. `readCompactChunk()` simultaneously holds compressed parts, the combined compressed
  buffer, decompressed parts, the combined body, decoded text, and parsed rows.
- Search owner coverage is limited by `PROJECT_DATA_ARCHIVE_SEARCH_MAX_OWNERS` (default 4, hard cap 64) while 111 owners are occupied. The service serially queries the selected prefix and exposes a
  single `reason`, conflating owner omission and execution errors.
- Incremental materialization caps a pass at 5,000 raw rows and may leave a terminal session
  `partial`. The archive anchor omits `materialized_through_created_at` and
  `materialized_through_sequence`. Pruned grouped text cannot be reconstructed from the grouped
  table, and compact archives cannot fall back to SQLite raw `LIKE` because raw rows live in R2.
- `searchMessagesFts()` catches FTS errors and returns an empty result, so caller metadata cannot
  distinguish a lexical execution failure from a true empty result.
- `pnpm quality:cloudflare-cost --start-date=2026-09-14 --end-date=2026-09-20 --recent-days=3`
  reports a usage-derived projected monthly total of $2.01 across the account. The ProjectData
  namespace accounted for 31.14k GB-s, 1.17B rows read, and 5.17M rows written in the window.
  Sep 19/20 rose to 5.70k/6.42k DO GB-s and 131.98M/227.84M rows read. These namespace totals are
  confounded by all ProjectData activity and must not be presented as archive-only cost.
- Relevant retained incident lessons require real workerd boundary fixtures, byte-shaped oversized
  rows, immutable publication/CAS fencing, explicit capped-selection disclosure, and deployed-state
  checks. Tests using ordinary SQLite cannot prove Cloudflare memory, bind, subrequest, or RPC limits.

## Implementation checklist

### Archive attribution, bounded memory, and repeated work

- [x] Add bounded, content-free migration progress evidence for phase, table, ordinal, source and
      stored byte counts, operation outcome/duration, lease epoch, and request correlation. Record the
      last-started operation so resets/timeouts remain attributable when completion logs never happen.
- [x] Freeze copy layout fields needed by retries in the migration journal. Existing in-flight and
      legacy migrations must retain their current layout and reader/recovery semantics.
- [x] Add durable per-table copy checkpoints, advanced only after target receipt is verified under
      the current migration and lease epoch. Reconcile target receipts ahead of a checkpoint and refuse
      incompatible/missing receipts rather than blindly overwriting or skipping.
- [x] Resume source export at the verified cursor/ordinal and preserve immutable R2 keys and chunk
      hashes across retries, including PUT-before-receipt and receipt-before-checkpoint resets.
- [x] Replace remaining chunk-level one-shot canonical hashes with byte-identical incremental hashes
      and eliminate safe attempt-local duplicate read/decompress/hash passes. Keep retry-time corruption
      checks and the final pre-delete target verification.
- [x] Bound grouped/tool export pages by actual serialized/canonical bytes with an explicit single
      oversized-row policy; do not truncate or livelock valid rows.
- [x] Reduce simultaneous compact-read representations where the v1 JSON/gzip format permits, and
      expose measured peak working-set proxies/read counts in production-shaped tests.
- [x] Classify timeout stage and cancellation behavior. An expired wrapper must not leave unbounded
      duplicate provider I/O racing a retry.
- [x] Measure source finalization row/byte/duration work. If one RPC remains unsafe, implement a
      durable, read-safe deleting continuation; otherwise record benchmark evidence that it is bounded.

### Complete destination index and migration-safe publication

- [x] Copy the full materialization watermark/index-state anchor contract and version it compatibly.
- [x] Before sealing/deletion, derive every missing grouped search document in the destination from
      ordered raw source/R2 data, including terminal partial sessions beyond 5,000 rows and pruned
      grouped indexes. Preserve stable message/group IDs, roles, timestamps, raw/tool references, and v1
      transcript hashes.
- [x] Store and verify explicit destination index coverage (source version/watermark, document and
      searchable-row counts/hash) separately from immutable transcript inventory. Refuse source deletion
      when transcript or index proof is missing, inconsistent, corrupt, or unavailable.
- [x] Add a bounded backfill/repair path for already published incomplete compact archives that reads
      R2 directly, is idempotent, reports progress/failure, and does not refill the pressured root.
- [x] Keep source-or-verified-target visibility throughout concurrent migration, publication, repair,
      and search; dedupe by stable logical identity and routing generation.

### Exhaustive project-wide history search

- [x] Replace the fixed total-owner cap with a query-bound owner inventory snapshot and continuation.
      Bounds limit concurrency/time/output per step; they must not permanently omit searchable owners.
- [x] Recheck project membership/authorization on every continuation and bind the cursor to project,
      normalized query, roles/session/time scope, inventory generation, and stable ordering state.
- [x] Query owners with configurable bounded concurrency, retry-safe owner progress, and deterministic
      global newest-first order `(createdAt, sessionId, id)` with stable deduplication.
- [x] Expose owner coverage, index coverage, provisional/final state, omitted/pending owners, and
      execution failures independently through the service and real MCP/session-search consumer. Never
      turn FTS failure into an empty successful result.
- [x] Preserve session-scoped exact routing, legacy readers, tool-call expansion links, and visibility
      while locations transition between root, migrating, sealed, and published states.

### Tests and measurement

- [x] Add meaningful unit and workerd tests for production-shaped long/tool/Unicode/noncompressible
      rows, one oversized row, >5k and 10k+ partial indexes, >64 occupied owners, equal timestamps,
      late/out-of-order rows, split terms, grouped-pruned compact sessions, and multiple generations.
- [x] Fault inject resets/timeouts after export, PUT, receipt, checkpoint, seal, manifest, verification,
      deletion, and publication; prove resume does not recopy verified prefixes or weaken delete proofs.
- [x] Test concurrent migration/search, missing/corrupt R2 objects, target/FTS failures, duplicate
      coordinators, lease theft, membership revocation, cursor tampering, rollback, and legacy formats.
- [x] Verify exact transcript text, message IDs/order, tool metadata/output retrieval, counts, hashes,
      complete lexical recall, deterministic top K, and physical source reclamation.
- [ ] Benchmark complete search cold/warm for empty, rare, common, historical, and filtered queries at
      current 111-owner shape. Capture p50/p95, wall latency, owner/row/R2 operations, billed DO duration
      (`durableObjectsPeriodicGroups.sum.duration`), rows read/written, and storage deltas.
- [ ] Separate one-time repair/backfill usage from ongoing query/migration usage. Use daily
      `pnpm quality:cloudflare-cost` series and aligned telemetry timestamps; do not estimate savings
      without measurements.
- [ ] Record a benchmark-backed decision on the existing architecture versus a separate partitioned
      search projection. Implement no new projection unless measured results justify it.

### Documentation, review, and rollout

- [ ] Update affected API/MCP contracts, operational docs, environment references, and the accepted
      idea with the measured decision. Preserve canonical complete-message storage/tool outputs in R2
      and session-owned storage as longer-term, separately authorized follow-ups.
- [ ] Run focused tests, lint, typecheck, full tests/build, migration safety, task completion
      validation, and independent Cloudflare/security/constitution/test/doc reviews; resolve blockers.
- [ ] Coordinate and deploy one pinned final candidate to shared staging. Exercise real R2, large
      archive resume, complete owner traversal, authorization revocation, concurrent chat/search, and
      corruption/error reporting; clean up only this task's resources.
- [ ] Create the PR, pass CI and iterative CodeRabbit review, merge, monitor production deployment,
      and verify deployed values/behavior without ad hoc deletion, copy-back, cleaner enabling, or a new
      destructive migration.
- [ ] Capture production before/after storage, migration progress/retry/read evidence, complete-search
      latency/coverage, and billed daily usage. Persist the observation checkpoint and continue for at
      least 24 hours; if the window is not complete, report it as pending and do not claim convergence.

## Acceptance criteria

1. A reset or timeout at any copy boundary resumes from verified durable progress with the same
   immutable v1 chunk layout; already verified prefixes are not exported, uploaded, decompressed, or
   committed again.
2. Peak working data is byte bounded for every copied table, and a valid oversized row has a finite,
   integrity-preserving path. Missing/tampered chunks and incompatible checkpoints still block delete.
3. Source removal occurs only after exact transcript/tool parity and verified complete destination
   search coverage. Partial/pruned sessions remain searchable through repair and publication races.
4. A complete project search can exhaust all relevant current/historical owners, returns stable
   deterministic results, and reports owner coverage, index coverage, pending work, and execution
   errors separately. No FTS failure is represented as a successful empty result.
5. Authorization and cursor binding prevent cross-project access and revoke continued access after
   membership removal; stable message identities preserve tool-call retrieval.
6. Production-shaped tests cover the specified scale/fault matrix and required repository gates pass.
7. Staging proves the pinned candidate against real R2 and the final PR clears specialist review, CI,
   and CodeRabbit before merge. Production deployment is monitored and read-only verification passes.
8. Cold/warm complete-search latency, billed usage, one-time backfill cost, and source/archive storage
   changes are measured. The separate-search-projection decision cites those measurements and invents
   no savings estimate.
9. At least 24 hours of post-rollout evidence is captured, or the durable observation is explicitly
   left pending without declaring sustained convergence.

## Safety and explicit deferrals

- No task action may perform ad hoc production deletion, copy-back, enable gated event/grouped
  cleanup, close the reopened breaker, or introduce a destructive production migration without a
  separate concrete approval under current SAM policy.
- Active-session, comment, snapshot, attention, ownership, lease, and terminal-version fences remain.
- Canonical complete-message storage, transient-fragment disposal, tool-output migration, and
  session-owned primary storage remain in idea `01M0YZNBKSKQZ47NC0K7M8N5AX`; they are not part of
  this implementation.

## Staging evidence (initial pinned candidate)

- Workflow `35674059977` deployed exact SHA `a85244d4c5f33372eabde653eb60a1be737c679d` and passed
  migration 0171 plus deployment smoke checks. The measured project had 264 archived sessions across
  108 owners; the scanned R2 prefix held 3,269 objects totaling 29,914,338 bytes.
- The first traversal repaired and reached 108/108 owners and 264/264 indexed archive sessions with
  no archive execution or index errors. Three steady 27-page traversals measured cold/warm p50/p95
  respectively: `playwright` 1,642/1,672/2,193 ms, `test` 3,185/860/1,870 ms, and `migration`
  1,884/727/1,936 ms. Their 74.505/66.446/63.495 s wall times include deliberate 1.25 s pacing.
- A fresh hidden no-result query disclosed a root-specific blocker after archive coverage completed:
  28 pages and 113.596 s still ended with `root_search_failed` on every page. The root raw `LIKE`
  fallback scanned already indexed history after an FTS no-hit, so search remained honestly partial
  but could never finish.
- Independent review rejected the first tail-only SQL fix: one retrodated-sequence arm remained an
  unbounded active-history scan, system-origin user-role rows were not filtered, and failed sessions
  could still hide delayed rows. The replacement uses migration 059's partial dirty-queue index and
  projection version. Every pre-upgrade nonempty root session receives a lazy bounded audit; new
  writes clear the version, and rows behind the full timestamp/sequence watermark request a durable
  paged rebuild. One root pass runs per signed continuation request and exposes
  `root_index_incomplete` as index progress rather than an execution error. Real Workers tests measure
  500 rows maximum materialized per SQL page, 5,000 rows per pass, zero project-wide raw `LIKE` reads,
  and at most one dirty-queue row read in steady state on a 6,001-row active history. Separate fixtures
  cover system-origin exclusion, pre-upgrade retrograde rows, equal-timestamp/lower-sequence rows,
  pruned repair, and a delayed split assistant term on a failed session. Rebuild deletion atomically
  retains complete grouped rows in an exact-session backup until the replacement FTS version is
  complete; movement is capped by rows and UTF-8 bytes with one-oversized-row progress, cleanup is
  paged, session deletion has an explicit backup-cleanup trigger, and archive source finalization
  removes the backup in the same transaction while retaining its routing anchor. A 501-group fixture
  pauses after
  the first 500-row page and still retrieves deleted head text plus a saturated raw tail before
  dedupe. Two 100k grouped rows move one at a time. An injected FTS-table failure proves projection
  writes roll back and cannot stamp a false-complete version. An injected source-finalization failure
  proves the backup and transcript roll back together; success and idempotent retry both clear the
  temporary backup.
- Sep 22 target-object billed metrics moved from 72 to 182 GB-s, 254.59k to 2.02M rows read, and
  5.25k to 46.62k rows written across the combined one-time repair and benchmark workload. The
  resulting approximately +110 GB-s / +1.765M reads / +41.37k writes is deliberately recorded as a
  mixed workload, not a per-query cost. R2 growth was deployment/agent-confounded. Post-fix aligned
  measurements, the separate-index decision, and the 24-hour production observation remain pending.

## References

- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- `apps/api/src/scheduled/project-data-archive-sharding.ts`
- `apps/api/src/durable-objects/project-data/archive-sharding.ts`
- `apps/api/src/project-data-archive/compact-r2.ts`
- `apps/api/src/durable-objects/project-data/{compact-archive,materialization,messages}.ts`
- `apps/api/src/services/project-data.ts`
- `apps/api/tests/workers/project-data-{compact-archive,archive-sweep-throughput}.test.ts`
- `.claude/rules/76-cost-decisions-must-query-billed-metrics.md`
