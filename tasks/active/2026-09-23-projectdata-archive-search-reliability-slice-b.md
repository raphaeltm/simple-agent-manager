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
  inventory. Failures remain visible and retryable; they cannot become successful empty results.
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
- [ ] Complete Cloudflare, security, test, constitution, documentation, and task-completion reviews;
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
3. Owner coverage, index coverage, pending repair, and execution errors remain distinct. Root, archive,
   FTS, and missing/corrupt-object failures cannot appear as complete successful empty results.
4. The six configurable bounds are wired through every deployment path and their deployed staging
   values match the checked-in defaults.
5. Tests, specialist reviews, one pinned staging deployment, measurements, CI, and the review gate are
   complete with durable evidence.

## Explicit deferrals

- **Slice C:** DO migration 059, bounded root history indexing, `materialization.ts`, `messages.ts`,
  materialization row schemas, grouped rebuild backup, and incremental-materialization/storage-safety
  tests. In particular, `classifyRootSearchError()` and continuation-driven root index advancement from
  parent commit `7868bc894` stay out of Slice B.
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
- Focused service, MCP, SAM-session, and archive-sharding unit suites pass: 4 files, 333 tests. API
  typecheck passes. Added direct coverage for project binding, fixed cursor lifetime, foreign-project
  owner exclusion, and SAM-session continuation forwarding.
- Full local gates pass: `pnpm check:fast`; `pnpm typecheck` (19/19 tasks); API Node suite (751
  files, 10,263 tests); full workerd suite (88 files, 1,180 tests); `pnpm build` (9/9 tasks);
  migration safety; Durable Object migration safety; and Wrangler binding validation.

## Benchmark and architecture decision

Pending pinned staging measurement. This section will separate steady queries from one-time repair and
will cite billed `durableObjectsPeriodicGroups.sum.duration`; invocation `wallTime` will not be used as
cost evidence.

## Specialist review evidence

| Reviewer                  | Status  | Outcome     |
| ------------------------- | ------- | ----------- |
| cloudflare-specialist     | PENDING | Not started |
| security-auditor          | PENDING | Not started |
| test-engineer             | PENDING | Not started |
| constitution-validator    | PENDING | Not started |
| doc-sync-validator        | PENDING | Not started |
| task-completion-validator | PENDING | Not started |

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
