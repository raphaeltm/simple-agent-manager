# ProjectData terminal archive-sharding bridge

## Problem

The production SAM ProjectData Durable Object is a single per-project SQLite owner and reached
9,468,043,264 / 10,000,000,000 bytes (94.680%) on 2026-08-31. The existing tool-payload retention
firebreak slows growth but does not provide long-term capacity for transcript text. The D1
`session_summaries` read index is also permanently incomplete once a project exceeds the configured
row cap (2,067 indexed rows versus 3,808 sessions in the production report), forcing hot session-list
reads back through the root DO.

Build the smallest zero-loss terminal archive bridge on fresh main. Packed same-class ProjectData
owners are archive placement only. Active-session one-owner `SessionData` is explicitly a later
end-state behind the owner/location seam. Migration stays production-disabled by default and is
driven by an external Worker sweep, never the root ProjectData alarm. This task ends at a draft PR;
there is no staging deployment, production/configuration mutation, or merge.

## Research findings

- The failed predecessor `01M1BQW8RFBQ85FGM5FW7AE7QB` never started an agent turn and has no code.
- Salvage audit for failed implementation task `01M1BSRST91TVJE9MCCQ022WAD` found three local-only
  commits in its durable transcript: `a68075003` (initial bridge), `3ed56e504` (recovery hardening),
  and `14e27ee25` (fence/index tests). The agent reported 11/11 focused Workers tests passing before
  later edits, then died after a SAM check-in. GitHub has none of those commit objects, the remote
  salvage branch still points at this task-only commit (`fc00176ad`), the replacement workspace's
  Git object database has no recent unreachable commits, and read-only production D1 shows the old
  workspace `01M1BSRY52X8WGG38HK78BVZ3S` is deleted with no `session_snapshots` row. The unpushed
  implementation bytes are therefore unavailable, but its design/file/test trace remains usable
  evidence. Continue on this branch and preserve that design rather than reviving PR #1873 wholesale.
- Current branch HEAD exactly matched fresh `origin/main` at `78d29db006cc6f9b6ac8cff71485c2d3d070b06a`.
- Draft PR #1873 used root-alarm migration, PRAGMA page estimation, root-owned shard metadata, whole
  session bundles, and project-wide shard fanout. Those are compatibility/negative evidence only;
  this task will not port the PR wholesale.
- Root ProjectData routing is centralized in `apps/api/src/services/project-data.ts`, but the DO class
  also exposes direct RPCs. A generation-aware `ProjectDataOwnerLocation`/`ProjectDataOwnerRef` seam
  must therefore live at the service boundary while target/source RPCs independently validate the
  same expected owner, generation, migration, and project/session identities.
- DO migration 041 is currently last; the archive-local schema must use the next append-only ordinal
  at land time. D1 migrations currently reach the 0131 family; the next free filename must likewise
  be checked immediately before the final push. No table recreation or destructive migration is safe.
- `session-summary-sync.ts` stops forever when `sessionCount > SESSION_INDEX_MAX_ROWS`. Fix it with a
  bounded, resumable keyset backfill cursor and incomplete coverage until every page commits; do not
  increase or hardcode the cap.
- Session snapshot recovery has several independent resumer gates: initial claim/reclaim,
  source-task authorization, TaskRunner per-step authorization, in-progress transition, and final
  ProjectData wake. Each must check the same D1 archive fence, and the source DO must check its local
  intent token/expiry so a stale D1 observation cannot authorize a late wake or write.
- Cloudflare DO RPC serialization is capped at 32 MiB. Copy must use independently idempotent rows/byte
  bounded chunks and must prove a logical session larger than 32 MiB without returning one bundle.
- DO `sql.databaseSize` is the quota/reclaim authority. PRAGMA estimators are prohibited.
- DO and D1 cannot share a transaction. The safe distributed ordering is: publish a D1 `migrating`
  pointer/fence by CAS; establish matching source-local intent; copy and seal target; atomically delete
  source payload rows only after rechecking both fences/version/coverage; then atomically CAS the D1
  location and journal to `archived`. Exact operations fail closed while the pointer is transitional,
  so crashes create temporary unavailability rather than ambiguous ownership or data loss.
- Last-resort recovery needs immutable evidence outside both SQLite owners. Persist each canonical
  chunk plus the sealed aggregate manifest under a deterministic private R2 recovery-bundle prefix
  before source deletion.

## Recovery validation (2026-08-31, task `01M1CC6K3E6YS0TS6ANKJ6DAT0`)

Third recovery pass after salvage retry `01M1C8FAEGZP7ESD8MGC1477NA` died on `node_not_running`
at 2026-08-31T16:58Z mid clean-baseline validation. Branch state audited, not trusted:

- `origin/sam/replace-provisioning-only-failed-022wad` head `532f1ebf9307b1558ec7295e21902d6eaefe5bf5`
  contains only this document (two commits: `fc00176ad` plan, `532f1ebf` salvage-audit findings plus the
  backlog→active move). The delta vs merge-base `78d29db00` is exactly one markdown file. No
  implementation code exists anywhere on the branch; nothing was discarded.
- The three lost implementation commits (`a68075003`, `3ed56e504`, `14e27ee25`) are absent from this
  workspace's Git object database (`git cat-file` fails on each), matching the salvage audit's GitHub/D1
  findings. No stashes, no uncommitted work, and `sam/continue-salvage-zero-loss-1477na` does not exist
  on the remote. The implementation bytes are conclusively unrecoverable; a fourth salvage search would
  be wasted work.
- Both failed sessions' durable transcripts are context-compacted. The last surviving trace from
  session `eaaec926` (≈15:18Z, 35 minutes before its death) records the lost implementation state:
  review had exposed real crash gaps (source deleted before D1 advanced past `sealed`; target sealed
  before journal transition; local source deletion before journal transition); the agent was adding an
  idempotent local `source_deleted` proof path so the coordinator could safely advance D1 after that
  crash, had converted sealing into one-chunk-at-a-time target verification with durable progress, and
  still owed tightened publish/freeze CAS and source-lease epoch before expanding recovery tests. The
  security and Cloudflare passes had found cross-store failure windows the happy-path suite masked.
  These are requirements the next implementation must include, not evidence of a finished bridge.
- The salvage session's last trace (≈16:47Z) confirms it had only recovered the design/commit trace,
  preserved it in this document, and pushed the resumed branch state before dying during baseline
  validation (its container lacked a `pnpm` shim; no repository error was ever observed).
- Design anchors re-verified against current `origin/main` (`4e6765d1e`, "ProjectData pre-wall storage
  relief (#1978)", merged after this branch's base): `SESSION_INDEX_MAX_ROWS` cap still exists in
  `session-summary-sync.ts`; `tool_payload_archives` and `chat_messages_grouped_fts` surfaces still
  exist; D1 migrations still end at the `0131` family. Drift to carry into re-implementation: the last
  DO migration is now `042-chat-search-materialization-state` (PR #1978), not `041` as recorded above —
  the "check the next free ordinal immediately before final push" rule is mandatory, and the
  archive-local schema must start at 043+ on current main. PR #1978 also added
  `storage-relief-measurement.ts`, `tool-payload-archive-r2.ts`, and storage-safety/alarm changes that
  the archive bridge must compose with, not duplicate.
- Verdict: the design in this document is complete and current, but the branch carries no
  implementation, so none of the implementation review gates exist to review (production-disabled
  default flag, fail-closed routing, D1 journal/lease/fence schema, bounded source/target RPCs,
  eligibility gates, canonical hashes, atomic finalize ordering, generation/location publish, deploy
  guard, crash/fence/hash/routing/reclaim tests). Per the recovery task's contract, no draft PR was
  opened and nothing was restarted. Next step: Fable/coordinator design review of this document, then
  re-implement from it on top of current main (base `sam/continue-zero-loss-projectdata-j6dat0`,
  rebased onto `4e6765d1e`), so a third implementation attempt does not die on unreviewed design
  assumptions.

## Production canary defect: SQL bind-variable ceiling (2026-09-04, task `01M1Q8NH6D8K8QG18JKKYP8PKF`)

The first production canary runs on project `01KHRJGANBBWGDY1NZ0KVF0D4J` showed 9 published
sessions and 2 failures. All 9 "successes" had `message_count = 2`; both failures carried
`error_message = 'too many SQL variables at offset 421: SQLITE_ERROR'`. The canary had therefore
validated nothing beyond trivial sessions, and the acceptance criterion above — *a logical session
larger than 32 MiB migrates over multiple idempotent chunks under configured row and byte limits* —
was not actually met.

Cause: `readCommittedRowsForChunk` (`archive-sharding.ts`), the post-insert verification read,
bound one placeholder per chunk row. Cloudflare's SQL surfaces reject the 101st bound parameter and
`PROJECT_DATA_ARCHIVE_CHUNK_ROWS` is 500 in production, so every session above 100 messages failed
deterministically. Offset 421 pins it: for the `chat_messages` column list the first `?` is at byte
121 and `421 = 121 + 3 * 100`. The INSERT was never implicated — `insertArchiveRow` writes one row
per statement (8/5/15 binds).

Both callers were affected: `commitArchiveTargetChunk` (forward copy) and
`restoreSourceArchiveChunk` (rollback recovery).

Fix: the verification read is sub-batched at the existing shared `D1_MAX_BOUND_PARAMETERS`
(`apps/api/src/lib/d1-limits.ts`). `chunkRows` is unchanged — lowering it to 100 would turn a
5190-message session into ~52 chunks x 3 tables of (DO RPC + R2 put + DO RPC) inside one
invocation, because the wall-time break only fires between migrations, never inside `copyChunks`.

Why the suite missed it: the DO unit suite runs on `better-sqlite3`, whose bound-parameter ceiling
is far above 100, so it cannot reproduce this at any fixture size; the largest fixture anywhere was
12 rows. The regression tests therefore live in the Workers pool
(`tests/workers/project-data-archive-sharding.test.ts`) against real workerd SQLite, and drive
`runScopedProjectDataArchiveCanary` and `copyBackProjectDataArchiveMigration` — the exact entry
points that failed in production. Verified discriminating: against pre-fix code they reproduce the
byte-identical `too many SQL variables at offset 421: SQLITE_ERROR`.

Operational note: sessions `e2c249ce` (5190 msgs) and `13329d54` (1600 msgs) are `failed`, and
`e2c249ce` sits at `attempt_count = 2` against `PROJECT_DATA_ARCHIVE_POISON_AFTER_ATTEMPTS = 3`.
Do not re-run the canary until this fix is deployed, or that session is poisoned.

## Reader/writer inventory and disposition

This inventory is machine-checked by the archive-sharding inventory test. New direct references to a
migrated table or resumer predicate must update the implementation and this table.

| Dependency / surface | Current readers and writers | Bridge disposition |
| --- | --- | --- |
| `chat_sessions` | sessions lifecycle/list/detail, message count/topic/update time, summary sync, materialization, comments/ACP/ideas FKs | Retain authoritative root row. Copy a non-authoritative target anchor only for local FK/search joins. Root terminal version is rechecked before delete. |
| `chat_messages` raw transcript | `messages.ts`, `message-persistence.ts`, chat/MCP/fork/final-message/debug/compaction readers, comments anchor validation | Copy all columns in bounded chunks; exact transcript/count/tool reads route to authoritative owner and generation. Source writer fence blocks late inserts. Delete only in one final source transaction. |
| `chat_messages_grouped` | materialization and LIKE/FTS search | Copy all columns in bounded chunks. Rebuild target FTS from committed grouped rows; source grouped and FTS rows delete in final transaction. |
| `chat_messages_grouped_fts` | `messages.searchMessagesFts` | Reconstructed from committed grouped rows, never trusted as copied bytes. Search is a bounded partial plane across configured archive owners plus root. |
| `tool_payload_archives` | lazy tool-content and MCP archive listing; archival cleanup writes manifests | Eligibility requires inline payloads already archived/stripped. Copy all manifest columns; exact tool reads and session-scoped archive listing route. R2 payload objects remain private and unchanged. |
| `tool_payload_cleanup_attempts` | retention retry/candidate selection | Retain root. Eligibility rejects pending/retryable/incomplete cleanup state. No migrated rows remain eligible for cleanup. |
| `session_state.current_plan_json` / plan messages | session state/wake UI and persisted plan readers | Retain root `session_state`; latest `plan` message is included with raw messages and routed with transcript reads. |
| D1 `session_summaries` / `last_message_at` | cross-project lists and project sidebar | Retain as eventual summary plane. Replace the 1,000-row-style permanent cap with resumable complete coverage; no per-session-owner fanout. |
| message count / dedup / sequence | `chat_sessions.message_count`, content dedup query, `MAX(sequence)` | Root count retained for summary. Exact count routes. All transcript writes fail closed once D1 or source-local intent exists; immutable archive owners reject writes. |
| liveness/activity/ACP/workspace/attention/inbox/task-waits | ProjectData lifecycle and control-loop modules | Retain root. Terminal archive placement never becomes live-session coordination. Recovery/wake predicates receive explicit D1+DO fences. |
| message comments/replies | comments read/write plus message-anchor existence | Retain root and never cascade-delete. Candidate eligibility requires zero message-anchored threads/replies before intent and again in final source transaction. |
| ideas/session links and other project metadata | ProjectData root modules | Retain root; archive migration does not route or delete them. |
| exact service reads/writes | `services/project-data.ts` and all API/MCP consumers | Resolve D1 location. `root` permits existing RPCs; `migrating` fails closed; `archive_shard` uses bounded archive RPCs with matching generation; unknown/mismatched generation never silently falls back. |
| project-wide search | MCP/search consumers | Return results plus explicit `partial`, owner-count, and reason metadata. Query root plus a configured maximum of packed archive owners, never thousands of session owners. |

## Implementation checklist

- [ ] Add additive D1 journal/location/circuit-breaker/index-cursor schema and matching Drizzle types,
      using the next free migration number at final push.
- [ ] Add additive ProjectData local intent/target-chunk/seal schema using the next DO migration
      ordinal at final push.
- [ ] Define generation-safe root/archive-shard/direct-session owner abstractions and deterministic
      owner names; validate project/session/owner/generation on every archive RPC.
- [ ] Add source RPCs for eligibility/intent, bounded canonical chunks, final fence/version/dependency
      verification, atomic payload deletion, frozen intent inspection, and databaseSize diagnostics.
- [ ] Add target RPCs for prepare, idempotent chunk commit, committed-row hash verification, FTS
      reconstruction, aggregate seal, re-home/export, and generation mismatch failure.
- [ ] Implement canonical serialization and SHA-256 for every migrated column, per chunk and aggregate;
      row counts and byte estimates remain diagnostics only.
- [ ] Persist deterministic immutable R2 recovery chunks/manifest before source delete.
- [ ] Implement an external scheduled Worker coordinator with D1 CAS journal/leases, bounded candidates,
      retries, poison-candidate escape, circuit breaker, freeze/forward-fix recovery, root capacity-gated
      copy-back, and clean-owner re-home fallback. Default disabled.
- [ ] Wire exact transcript/count/tool-archive reads through D1 locations; fence writes/wake paths in D1
      and in source-local state; fail closed on transitional/missing-generation mismatches.
- [ ] Add recovery-fence checks to initial/reclaimed snapshot claim, source authorization, every
      TaskRunner resumer step/transition, and final ProjectData wake, with a machine-checked inventory.
- [ ] Replace the permanent D1 session-index cap with bounded resumable keyset completion and preserve
      explicit eventual/partial list semantics without owner fanout.
- [ ] Make search return explicit partial-plane metadata and bound archive-owner fanout by config.
- [ ] Add a deploy-time compatibility guard that blocks a build without the required routing version
      once authoritative non-root pointers exist.
- [ ] Document every new flag/budget/default and the migration-disabled operational/rollback/DR model
      in env reference, `.env.example`, architecture/configuration docs, and relevant project docs.
- [ ] Create/link a SAM Idea for active-session one-session `SessionData` direct ownership if it cannot
      safely fit this PR.
- [ ] Run full validation and the Cloudflare, security, test, constitution, env/doc, task-completion,
      and iterative label-triggered CodeRabbit review gates. Address every correctness finding.
- [ ] Open a draft PR for coordinator/Fable review. Do not stage, mutate production/configuration,
      mark ready, merge, or deploy.

## Acceptance criteria

- Production migration is disabled by default; no root alarm initiates archive work.
- An external Worker sweep can resume a D1-journaled migration after a crash at every phase without
  duplicate ownership, lost rows, or unbounded RPCs.
- Source deletion is one local transaction and cannot occur without a sealed target aggregate hash,
  live D1 lease/fence, matching source-local token/expiry, unchanged terminal version, and repeated
  dependency/eligibility coverage.
- Canonical hashes cover every migrated column. The target recomputes every chunk hash from committed
  rows and the session aggregate from those verified committed chunks. Count/byte equality alone cannot
  authorize deletion.
- A logical session larger than 32 MiB migrates over multiple idempotent chunks under configured row and
  byte limits. The target can contain a partial copy without becoming authoritative.
- Restorable snapshots/recovery, comments, late writers, non-terminal/grace-age sessions, unarchived
  tool payloads, expired/mismatched fences, hash mismatches, poison rows, and generation mismatches all
  fail closed with discriminating Workers-runtime tests.
- Root `chat_sessions`, comments, liveness/state/dedup authority, plan state, summaries, and unrelated
  metadata survive archive placement. Comment rows are never cascade-deleted.
- Exact transcript reads use one authoritative owner. Exact writes fail closed once migration begins.
  List/search explicitly disclose eventual/partial semantics and never fan out to thousands of owners.
- Re-home/repack works. Rollback freezes and forward-fixes; root copy-back requires the configured
  databaseSize capacity gate, otherwise data moves to a clean archive owner. Immutable R2 recovery
  evidence exists before source deletion.
- The D1 session index can converge beyond the old cap through bounded pages and reports complete only
  after all pages commit.
- Workers-runtime tests cover source `sql.databaseSize` reclaim after finalization.
- CI, local quality suite, mandated specialist reviewers, task completion, and CodeRabbit have no
  unresolved blocking findings. The PR remains draft and unmerged; staging is explicitly skipped by
  user instruction.

## References

- SAM task `01M1BSRST91TVJE9MCCQ022WAD`
- Failed predecessor `01M1BQW8RFBQ85FGM5FW7AE7QB`
- SAM idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- Project library `/health-reports/health-report-2026-08-31.md`
- Draft PR #1873 / `origin/sam/do-sharding-implementation` (research only)
- `.claude/rules/31-migration-safety.md`
- `.claude/rules/44-dual-write-migration-enumerate-writers.md`
- `.claude/rules/45-durable-object-concurrency-mutex.md`
- `.claude/rules/47-control-loop-io-budget.md`
- `.claude/rules/49-capture-prerequisites-before-async-completion.md`
- `.claude/rules/50-list-read-row-fault-isolation.md`
- `.claude/rules/51-runtime-boundary-validation.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `.claude/rules/60-request-io-and-bundle-budgets.md`
- `.claude/rules/67-shared-predicates-that-trigger-actions.md`
