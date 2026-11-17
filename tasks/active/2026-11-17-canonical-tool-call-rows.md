# Canonical tool-call transcript rows

## Problem
Task 01M7KYS4CDX80CXQ31DVTX54WW; parent 01M7KXHRDQ6C08JCHTRH5R3QQK. Reduce billed DO SQLite writes by updating one canonical tool row per authenticated outbox incarnation/toolCallId. Default OFF; no production test/settings writes.

## Preflight and research
Classes: cross-component-change, business-logic-change, public-surface-change, ui-change, docs-sync-change.
Billable entity: workerd SQL cursor rowsWritten, including indexes; INSERT tool row costs 3, content/metadata UPDATE 1. Preserve grouped search economics rather than multiplying groups per concurrent call.
Sources: idea 01M7HX6F51Z8GYS93PV6XWAFWT updates 01M7KM9VMP6FVFCW55Y117KGYN, 01M7K4ZSKGX5RH41DAMPJW8XAP, 01M7K4WPYC2E3V5RY5CHT38MFB; verified ingest code matches origin/main a3d3246c0.
Existing persistMessageBatch uses archive mutex and synchronous transaction. MessageStreamBatch has durable source/sequence frontiers, recent UUID receipts and retired sources. Must activate for tool merging independently of text setting. Every tool event breaks assistant run and consumes a logical position/count.
Tool metadata has no start/update discriminator. Within an authenticated outbox incarnation toolCallId identifies one call; replay suppression in session_host_client.go is before all notification handling. New incarnation gets a distinct canonical identity. Deterministic source/incarnation/tool ID hash avoids an evictable locator map and new index; PK is the recovery path.
Materializer combines consecutive tools across pages; mutation behind watermark needs exact grouped/FTS refresh without full-session rebuild. Existing source-archive fences precede writes. Offload stubs require hydration or explicit refusal before mutation; never fallback insert into fenced/owned rows.
Client same-ID merges retain stale rows; lazy cards retain local output. Revision must replace snapshots and invalidate cached/in-flight lazy output. Old bundles need explicit resync compatibility.
Relevant lessons: rules 31, 44, 45, 69 (archive SQL limits/memory), 73 (sparse absence), 17/56 (real-browser visual assertions), 62/35 (real-trigger vertical slices).

## Implementation checklist
- [ ] Split affected source modules over 500 lines in a separate refactor commit.
- [ ] Add typed default-OFF admin setting and kill switch; preserve exact OFF behavior.
- [ ] Deterministic canonical identity, monotonically increasing durable revision, bounded atomic retry receipts.
- [ ] Sparse output/title/status merge, terminal monotonicity, missing starts, concurrent calls, source rotation and eviction/restart.
- [ ] Preserve notification sequence reservation, logical turn counts and assistant frontier boundaries.
- [ ] Refresh indexed grouped text and FTS after indexed canonical row mutation.
- [ ] Preserve archive mutex/generation/write fences; handle offloaded rows without stale pointers/proofs.
- [ ] Revision-aware web/acp-client merges, logical grouping and lazy output invalidation; old-bundle compatibility.
- [ ] Document intermediate-history, sessions_read cursor/count semantics and comment anchors.
- [ ] Workerd vertical slices through real ingest for Claude, Codex, OpenCode ON/OFF; assert rows, final snapshots, billed writes and retries.
- [ ] Discriminating tests for statuses, late content, source rotation/restart/eviction, archive/offload, materialized mutation and client cache.
- [ ] Playwright desktop/mobile stress audit and reviewed screenshots posted to PR.
- [ ] Full lint/typecheck/test/build; local specialist/task-completion review; CodeRabbit request/wait and green CI.
- [ ] Coordinate staging2 lease; real three-harness ON/OFF sessions, reload/cards/lazy/search and row_usage counts; clean up and restore setting.
- [ ] Merge, monitor production deploy, verify setting remains OFF and send counts-only evidence to coordinator/channel.

## Acceptance criteria
Every item above is evidenced by automated tests or documented staging observations; no guard relies only on mocks/source strings. No raw production data in evidence. Never merge incomplete gates.
