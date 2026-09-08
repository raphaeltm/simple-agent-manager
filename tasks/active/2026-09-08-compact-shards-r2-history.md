# Compact archive shards with lossless R2 history and write budgets

## Request and constraints

Raphaël approved keeping metadata, consolidated searchable conversation records and indexes in SQLite shards, with raw streaming history and bulky tool metadata in compressed private R2 chunks. Implement directly in this conversation via `/do`; no delegated implementation. Preserve retrieval/search and keep PR #2033 throttles. A projected ~$100/month SQL overage is explicitly unacceptable.

Do all implementation, review, CI and staging work before presenting an exact production mutation plan. The existing ProjectData rollout policy requires approval for destructive production migration. New format defaults off until that gate; legacy reads continue regardless of the write flag.

## Preflight and research

Classification: external-api-change, cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change. No UI redesign.

Billable boundary: account-wide DO SQLite row reads/writes; SQL indexes and FTS virtual-table changes contribute writes, and source deletes are billed. Transactions/batching alone do not reduce charged rows. R2 Standard charges per object operation and stored bytes. Official references: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ , https://developers.cloudflare.com/durable-objects/platform/pricing/ , https://developers.cloudflare.com/r2/pricing/ . Existing R2 Workers API and streaming compression avoid new dependencies.

Current flow: coordinator `copySourceChunks` exports three source tables, writes recovery JSON to R2, then duplicates ALL rows into a target ProjectData DO. `sealArchiveTarget` recomputes table and terminal hashes and rebuilds grouped FTS; source finalization deletes original rows after persisted recovery proof. Routing `services/project-data.ts` selects the exact owner for transcript, count, tool-content, archived payloads and search. Existing copy-back exports from target and verifies the original terminal hash on root.

Implementation choice: versioned storage format pinned to the target session; compact targets store raw `chat_messages` chunks in gzip R2 with authenticated-by-hash SQLite chunk references and role/time/ID metadata. Existing consolidated `chat_messages_grouped` and tool archive pointers remain SQL so search and old tool-payload lookup semantics are preserved. This removes raw-row target inserts without modifying original history or legacy manifests. Persisted format, not today's env flag, governs all reads/retries.

Every writer/reader affected: coordinator target prepare/commit/seal/manifest; source prepare/finalize/copy-back and abandon; target exact message paging/count/tool expansion/export; project/session grouped search. Normal root writers (`messages`, message-persistence, system messages) remain root-only behind the existing source-intent fence. Target mutators must serialize across R2 awaits. Existing published row-based shards remain readable; do not auto-rewrite them during schema upgrade.

Incident lessons: Aug 26 unseekable scans amplified read bills; Sept 5 whole-session hashing exceeded DO memory; Sept 6 pre-copy refusals stranded migration fences; Sept 8 sessions/hour was not a cost budget. Use bounded chunk streams, exact ownership/hash checks, durable budget deferral, and observe both billed writes and database bytes reclaimed.

## Implementation checklist

- [ ] Add additive compact-session/chunk-reference schema and versioned types; test fresh and upgrade migration paths.
- [ ] Add bounded gzip R2 chunk codec with read-back verification, identity/hash validation, corruption/size failure and immutable retry behavior.
- [ ] Commit raw chunks as SQL references; retain grouped/search records and tool archive ledgers. Pin representation across retries and flag changes.
- [ ] Recompute source-compatible hashes/counts from streamed compact chunks before sealing; preserve manifest/source-delete invariants and concurrent-operation safety.
- [ ] Route exact transcript pagination, role counts, lazy tool content and export/copy-back to compact storage; preserve legacy behavior and fail closed on unavailable/corrupt archives.
- [ ] Enforce durable migration write-budget admission/defer semantics, measure actual SQL writes and bytes freed, prevent oversized-session budget bypass, reserve normal-traffic headroom; document hard versus estimated boundaries.
- [ ] Add realistic unit and Workers integration tests for complete migration/read/search/tool/copy-back, retries, corrupt R2, wrong ownership, budget exhaustion/refresh and demonstrably fewer target SQL writes.
- [ ] Update deployment env mapping, both env skills, examples, architecture/configuration docs and CLAUDE recent changes.
- [ ] Run local full quality gates and task completion/specialist review; fix findings.
- [ ] Coordinate staging, deploy final candidate, prove full retrieval/search/tool behavior through API/MCP and UI; record cost/storage evidence and clean up test resources.
- [ ] Create PR, get CI/CodeRabbit green, prepare exact production rollout plan under the existing approval policy; merge/deploy when authorized and gates satisfied.

## Acceptance criteria

- Complete original raw history round-trips exactly through compact R2 storage, including IDs/timestamps/sequence/origin/tool metadata; paging and count behavior match legacy.
- Consolidated user/assistant conversation text stays complete and searchable in SQLite shards; existing grouped search semantics stay intact.
- Compact target has no raw chat_messages rows; write reduction is measured against the identical legacy fixture in real Workers SQL.
- R2 loss/corruption/oversize/wrong-owner and concurrent retries never publish unverifiable history or delete the sole recoverable source copy.
- Restart and rollout-flag changes do not switch a migration's representation or break existing archives/copy-back.
- Budget exhaustion defers safely without poisoning or fencing new work forever; its allowance and finite unit of work are explicit and tested.
- Production throttles unchanged; deployment alone does not opt production into the new destructive migration format.

## Workflow notes

The current SAM checkout is already clean, isolated on its prescribed feature branch at main 6895aacd5. User requested work here, so keep the task and implementation in this checkout/branch instead of creating another worktree or pushing a task-only main commit.

## Implementation checkpoint (2026-09-08)

Compact codec and real-SQLite compatibility: 30 unit tests passed (including legacy suite). Real Workers archive suite: 10 tests passed, including budget refusal before fencing, complete compact migration/source deletion/routed retrieval, writer-off reads, copy-back and concurrent daily reservations. Focused API typecheck passed before final docs/metadata refinements; rerun in progress. New code remains off in production.

The daily budget is explicitly an estimate (default 250k/day with factor32 and FTS-text units), not an invoice cap. New compact candidates above the message cap remain on root; old legacy migration admission stays unchanged. Source deletion remains a whole-session operation. This is a deliberate safety boundary: do not claim arbitrary giant sessions can drain within a smaller per-day allowance. Actual SQL cursor-write and database-size telemetry accompanies target commit/seal/source delete. Additional cost comparison, failure/race tests, quality gates, independent review, staging and PR remain outstanding.

## Independent review findings and fixes

- Cloudflare/security review found recovery continuation lost at the RPC memory cap. Fixed by carrying `hasMore` explicitly; the 100-row ×200KiB metadata fixture now exercises default 16MiB recovery chunks. Source export and canonical hashing consume SQL cursors instead of materializing raw pages. Compact R2 read/export/seal passes share an operation deadline. Awaiting final reviewer recheck.
- Budget review found same-session contenders wasted permanent reservations. Only a definitive journal/lease loser can now release its unused reservation, atomically and idempotently; no interrupted/ambiguous work is refunded, and old-window releases cannot debit a new day. Real concurrent-canary and rollover tests pass. The pool is installation-wide, not shared across independent SAM installations.
- Completion review requested real routed search/tool/legacy-ledger coverage, true hash/gzip/decompression/stalled-body failures and coordinator restart pinning. Added. Compact Workers suite (new dedicated file) has six passing tests including those end-to-end flows. Additional large-object and shared-deadline refinements are being revalidated.
- Real Workers SQL cost fixture: 1,001 streaming fragments, same consolidation: **3,058 legacy target writes vs63 compact target writes** (~97.94% reduction for target writes only). Snapshot records the runtime counters. Source deletion remains billable.

Full lint13 packages passed, config mapping33 tests passed, D1 ordering passed. Full root test run failed on a now-fixed import error during an intermediate build; it is not counted as passing and must be rerun. Staging, CI and CodeRabbit still pending.
