# ProjectData exhaustive archive search — Slice B

**SAM task:** `01M37R64R6CQ3S98V1A58MHTZY`

**Parent implementation:** task `01M32TCPHE7D45WRJ9K6TC49JM` on branch
`sam/implement-reliable-projectdata-archiving-tc49jm` at `982e48ccf`. Slice B is carved from the
pre-Slice-C parent state at `a85244d4c`, after Slice A merged to main as `f5ff1e662`.

## Problem

Project-wide history search currently queries only a fixed prefix of archive owners. With more
occupied archive shards than the configured cap, a successful response can permanently omit
searchable history. The contract also lacks a safe way to continue through all owners and does not
separate owner coverage, index coverage, pending work, and execution failures clearly enough for
callers to distinguish a complete empty result from an incomplete or failed search.

## Preflight and research findings

- Classification: cross-component business logic, public MCP/session contract, documentation sync,
  security-sensitive signed state, and deployment configuration. No third-party API or new package is
  introduced.
- Data flow: MCP `handleSearchMessages()` and SAM-session `searchTaskMessages()` recheck current
  project access, then call `searchMessagesWithArchiveMetadata()`. The service snapshots the
  project-scoped D1 owner inventory, searches root plus bounded concurrent archive-owner batches,
  merges stable newest-first identities, and returns a signed query-bound continuation with separate
  owner/index/error coverage.
- The clean parent carve boundary is `a85244d4c`. Later commits `7868bc894` and `982e48ccf` are Slice C:
  DO migration 059, bounded root history indexing, grouped rebuild backup, materialization/messages
  changes, row schemas, and their Workers tests.
- Slice A omitted the two search-concurrency constants from
  `apps/api/src/project-data-archive/contract.ts`; the carved service imports them. Include that
  isolated two-line Slice B dependency. It is configuration only and has no schema or Slice C coupling.
- Slice A intentionally kept archive-owner search repair fixed and stripped coverage from the
  ProjectData RPC. Slice B therefore includes the separable search-only hunks in
  `archive-sharding.ts`, `index.ts`, and `types.ts`: configurable one-step repair and the existing
  coverage result crossing the RPC boundary. No migration, archive-copy, or root-index logic is added.
- Continuations must be tamper evident, finite-lived, byte bounded, bound to project/query/roles/limit,
  and re-authorized at every MCP continuation request. Cross-project owner rows must never be queried.
- Search work must bound concurrency and per-step owner count without permanently truncating the owner
  inventory. Archive-owner execution, index-repair, and missing/corrupt-object failures remain visible
  and retryable; they cannot become successful empty results. Root FTS classification requires the
  explicitly deferred Slice C `messages.ts` and bounded-root-index changes.
- The six new runtime variables must be added to the Worker type, top-level Wrangler vars, both env
  examples, sync allowlist, centralized `wrangler_sync_env` mapping, public configuration docs, and
  the repository env-reference skill. Both Wrangler sync invocations inherit the central mapping.
- Constitution checks: Principle XI requires all operational bounds to remain configurable; Principle
  XIII requires project identity validation, authorization refresh, and honest failure at boundaries.
- The relevant retained deployment incident is
  `tasks/archive/2026-07-29-wrangler-sync-env-parity.md`: duplicated per-step mappings drifted between
  first sync and tail-consumer re-sync. This slice updates only the centralized mapping.

## Implementation checklist

### Exhaustive search and contracts

- [x] Replace fixed total-owner truncation with a query-bound owner inventory and signed continuation.
- [x] Bound owner fanout with configurable concurrency and per-step progress while preserving stable
      deterministic ordering and deduplication.
- [x] Recheck project membership for every MCP continuation and bind continuation state to project,
      normalized query, roles, limit, issuance time, inventory, and progress.
- [x] Expose owner coverage, index coverage, pending work, provisional/final state, and execution
      errors independently through service, MCP, and SAM-session consumers.
- [x] Preserve exact session routing, legacy readers, stable message identities, and tool-call links.

### Configuration and documentation

- [x] Add the six `PROJECT_DATA_ARCHIVE_SEARCH_*` values with requested defaults to every required
      runtime, deploy-sync, workflow, example, public-doc, and env-reference surface.
- [x] Document continuation and complete-search behavior in chat, agent, architecture, and
      configuration docs.
- [x] Keep generated Wrangler environment sections absent and prove both sync invocations receive the
      central mapping.

### Tests, measurement, and rollout

- [x] Add focused service coverage for complete traversal, deterministic merge, bounded concurrency,
      tampering, expiry, query mismatch, cross-project isolation, repair/error disclosure, and legacy
      behavior.
- [x] Add MCP and SAM-session contract coverage, including authorization revocation mid-continuation.
- [x] Run focused and full API/Workers suites plus every requested local quality gate.
- [x] Complete Cloudflare, security, test, constitution, documentation, and task-completion reviews;
      resolve all blocking findings and record each result in the PR.
- [ ] Deploy one pinned SHA after checking shared staging occupancy. Prove complete archive-owner
      traversal, multi-page continuation, revoked membership refusal, concurrent chat/search, and
      missing/corrupt-object disclosure without provisioning a VM.
- [ ] Verify all six deployed Worker vars through the Cloudflare settings API and leave no GitHub
      Environment override created by this task.
- [ ] Benchmark cold/warm empty, rare, common, historical, and filtered queries at the current owner
      shape. Record p50/p95, wall latency, owner/row/R2 operations, billed DO duration, rows
      read/written, and separate one-time repair usage from steady query usage.
- [ ] Record the benchmark-backed existing-fanout versus separate-projection decision here and in idea
      `01M0YZNBKSKQZ47NC0K7M8N5AX`; implement no projection in this slice.
- [ ] Create the PR with validated preflight evidence, pass CI, request one trusted CodeRabbit review,
      and stop for Raphaël's waiver if CodeRabbit remains unavailable.
- [ ] After human-authorized merge, monitor production deployment and confirm the Worker deployment ID
      changed with the production debugging token.

## Acceptance criteria

1. Repeated continuations exhaust every owner in the frozen project-scoped inventory without an
   unbounded fanout, return deterministic deduplicated results, and disclose whether results are
   provisional or final.
2. Tampered, expired, mismatched, oversized, or cross-project continuations fail closed. Membership
   removal blocks the next MCP continuation before any owner search runs.
3. Owner coverage, index coverage, pending repair, and execution errors remain distinct. Archive-owner
   execution, index-repair, and missing/corrupt-object failures cannot appear as complete successful
   empty results. Root FTS classification remains an explicit Slice C acceptance item.
4. The six configurable bounds are wired through every deployment path and their deployed staging
   values match the checked-in defaults.
5. Tests, specialist reviews, one pinned staging deployment, measurements, CI, and the review gate are
   complete with durable evidence.

## Explicit deferrals

- **Slice C:** DO migration 059, bounded root history indexing, `materialization.ts`, `messages.ts`,
  materialization row schemas, grouped rebuild backup, and incremental-materialization/storage-safety
  tests. In particular, `classifyRootSearchError()` and continuation-driven root index advancement from
  parent commit `7868bc894` stay out of Slice B. Until Slice C lands, the existing root
  `searchMessagesFts()` path can still resolve an internal FTS error as an empty array; Slice B makes no
  completeness claim for that deferred root-index behavior.
- Canonical complete-message storage, transient-fragment disposal, tool-output migration, session-owned
  primary storage, and any separate partitioned search projection remain in idea
  `01M0YZNBKSKQZ47NC0K7M8N5AX`.
- A 24-hour post-rollout observation remains pending after production deployment and must not be
  described as completed convergence in this PR.

## Safety

- Do not close the production archive circuit breaker, delete or copy back production data, enable
  gated cleaners, provision staging VMs, or add any D1/DO schema migration.
- Preserve in-flight and legacy migration layouts and reader semantics.
- Stop with concrete dependency evidence if any required search hunk cannot be separated from Slice C.

## Evidence

- Starting branch `sam/ship-slice-b-projectdata-8mhtzy` is clean at `f5ff1e662`, current
  `origin/main`, and includes merged Slice A.
- Parent search carve is the relevant-file diff from `origin/main` to `a85244d4c`; the later Slice C
  diff is inspected independently and excluded.
- GitHub auth, Node, pnpm, staging token, production debugging token, and production account ID are
  available. No environment prerequisite is currently blocking implementation or measurement.
- Focused service, MCP, SAM-session, archive-sharding, and compact-R2 suites pass: 5 files, 354 tests.
  API typecheck passes. Added direct coverage for the real MCP-to-service continuation path, project
  binding, fixed cursor lifetime, independent coverage dimensions, configurable error/repair bounds,
  foreign-project owner exclusion, and exact-scope continuation rejection.
- Full local gates pass: `pnpm check:fast`; `pnpm typecheck` (19/19 tasks); API Node suite (751
  files, 10,272 tests); full workerd suite (88 files, 1,180 tests in 3,565 seconds); `pnpm build` (9/9 tasks);
  migration safety; Durable Object migration safety; and Wrangler binding validation.
- Staging workflow `35922767450` deployed exact tested code SHA
  `0a7ce28eff81cd1c56f6feee794700a08daf2552` successfully. The shared deployment queue was empty
  immediately before the one dispatch. The Cloudflare Worker settings API returned the requested
  values: concurrency `4`, repair sessions `1`, repair chunks `1`, continuation TTL `900000`, cursor
  max bytes `1048576`, and error limit `20`. GitHub's staging Environment contains no matching
  overrides. Staging D1 contains zero active VM nodes (268 historical rows are all `deleted`).
- The available staging Cloudflare token can query and mutate D1 and read analytics, but Workers KV
  writes fail with Cloudflare HTTP 401. Live `/mcp` probes require a disposable `mcp:<token>` KV entry;
  the public API intentionally has no token producer that avoids starting an agent runtime. The first
  harness attempt failed on its first KV write before creating a D1 fixture. A follow-up D1 check found
  zero `slice-b-*` users and zero temporary routing rows. Human input was requested for narrowly scoped
  staging KV edit access or a securely provisioned disposable MCP token; no secret should be pasted
  into task or chat text.

## Benchmark and architecture decision

The parent branch's initial pinned candidate was exact pre-Slice-C SHA
`a85244d4c5f33372eabde653eb60a1be737c679d`, whose Slice B search implementation is the code carved
here. Workflow `35674059977` measured the same 108-owner staging project before four more sessions were
archived (264 then; 268 now). Its first traversal repaired and reached 108/108 owners and 264/264
indexed archive sessions without archive execution or index errors. Three steady 27-page traversals
reported the following per-page cold/warm p50/p95 and paced end-to-end wall times:

| Query                  | Cold page | Warm p50 | Warm p95 | Complete traversal wall |
| ---------------------- | --------: | -------: | -------: | ----------------------: |
| rare `playwright`      |  1,642 ms | 1,672 ms | 2,193 ms |                74.505 s |
| common `test`          |  3,185 ms |   860 ms | 1,870 ms |                66.446 s |
| historical `migration` |  1,884 ms |   727 ms | 1,936 ms |                63.495 s |

The wall figures include deliberate 1.25-second inter-page pacing. A hidden no-result query completed
archive coverage but remained honestly incomplete after 28 pages / 113.596 seconds because every root
pass reported `root_search_failed`; the bounded root-index repair is the explicit Slice C dependency.
That prior run did not retain a separate filtered-query number, so fresh empty and filtered measurement
remain open behind the disposable-MCP-token blocker above.

The parent measurement's Sep 22 billed ProjectData delta combined first-use repair and queries:
`durableObjectsPeriodicGroups.sum.duration` rose approximately 110 GB-s (72 to 182), rows read rose
approximately 1.765 million (254.59k to 2.02M), and rows written rose approximately 41.37k (5.25k to
46.62k). It is a mixed one-time-repair-plus-query delta, not a per-query estimate. The read-only
production cost audit for Sep 20–22 independently reports 17.73k GB-s, 482.04M rows read, and 2.61M
rows written overall; the production ProjectData namespace accounts for 16.12k GB-s, 481.30M reads,
and 2.61M writes. Those aggregate production values provide context only and are not attributed to
search.

**Decision:** retain the existing bounded shard fanout and implement no separate projection in Slice B.
At the current 108-owner shape, archive traversal completed reliably with bounded four-owner
concurrency and sub-3.2-second observed page latency. The minute-scale complete traversal is material,
but current billed evidence is confounded by one-time repair, and the known non-converging empty path
belongs to the already-planned Slice C root index. A new projection would add consistency, backfill,
authorization, and lifecycle machinery without a clean steady-state cost result demonstrating that it
is needed. Reconsider after Slice C and an aligned repair-free benchmark; do not infer savings from the
mixed delta.

## Specialist review evidence

| Reviewer                  | Status | Outcome                                                                                                                                                          |
| ------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| cloudflare-specialist     | PASS   | Owner inventory/fanout, bounded DO/R2 repair, Wrangler/config sync, independent coverage, and strict Slice C exclusion pass                                      |
| security-auditor          | PASS   | Cursor signing/binding, authorization refresh, tenant isolation, and sanitized errors pass; unbounded query length deferred to idea `01M37Y00HSVM8VWSZCGXV8NDN3` |
| test-engineer             | PASS   | Vertical MCP continuation plus configurable bounds and error paths pass; 5 focused files / 354 tests                                                             |
| constitution-validator    | PASS   | Six settings remain configurable with bounded defaults; no Principle XI or scope violations                                                                      |
| doc-sync-validator        | PASS   | Runtime contracts, caps, per-collection error semantics, and Slice C root-FTS deferral are synchronized                                                          |
| task-completion-validator | PASS   | Implementation and tests satisfy Slice B; staging/benchmark/PR remain the expected pending phases                                                                |

## References

- Slice A: `tasks/active/2026-09-22-projectdata-archive-copy-reliability-slice-a.md`
- Parent task on the parent branch:
  `tasks/active/2026-09-21-projectdata-archive-search-reliability.md`
- Idea `01M0YZNBKSKQZ47NC0K7M8N5AX`
- `.claude/rules/07-env-and-urls.md`
- `.claude/rules/11-fail-fast-patterns.md`
- `.claude/rules/25-review-merge-gate.md`
- `.claude/rules/70-flag-flips-must-verify-the-deployed-value.md`
- `.claude/rules/76-cost-decisions-must-query-billed-metrics.md`
