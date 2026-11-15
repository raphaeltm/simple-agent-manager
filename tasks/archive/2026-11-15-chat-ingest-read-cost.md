# Bound chat ingest reads in ProjectData

Task: 01M7GB4125DFTECRYYCAHXAWTS. Part 1 of two sequential PRs.
Ideas: 01M7CX61WVX72T7CFQNRTX0DVM, 01M7FC4NXRWYFKM5YAF90GHY8C.

## Problem and evidence
Every two-second batch scans a session for MAX(sequence). Real workerd baseline with production migrations and 10,000 synthetic assistant rows: steady assistant batch merging OFF 10,016 reads / 10 writes; ON 10,022 reads / 8 writes. MAX alone reads 10,001 rows after warmup. User dedup already uses migration 014 partial content index (0 reads on miss), so needs no new index. FTS/grouped maintenance is deferred; batch persistence does not maintain them. These are local samples, not production forecasts.

## Writer inventory and proposed contract
- messages-persist-helpers.insertNewMessage (browser/RPC/prompt-delivery callers): allocate synchronously and advance session watermark in existing counter update.
- messages.persistMessageBatch: advance for every accepted logical message, including supplied sender sequences; preserve supplied reporter positions and the existing within-batch allocator exactly; the watermark must match MAX(sequence) plus the stream frontier. Merged append consumes logical positions even without new raw rows; persist watermark with stream receipts.
- messages.persistSystemMessage: advance in existing counter update.
- message-stream-ingest.MessageStreamBatch.flush: called by batch transaction only; canonical inserts covered by batch watermark; appends do not change existing raw row sequences.
- archive-sharding.insertArchiveRow: dynamic SQL used by archive target import and source copy-back/restore. Advance a known watermark once per chunk, preserve NULL for lazy initialization. Preserve archive hashes/column contracts and all fences.
- archive deletion, abandon, reclaim and session cascade: never decrease watermark. Restores must not introduce a row above a known watermark.
- prompt-delivery-steer, session-access-store, project-event-provider-limit-delivery, tool-payload-archive: content/metadata only; never alter session_id or sequence.
- migration 007 assigns legacy rowid sequences before new nullable watermark migration; new migration performs no backfill or destructive operation.
No separate nonarchive import path found in apps/ or packages/.

## Checklist
- [x] Read ideas and applicable rules 31,44,45,47,62,69,73,81; preserve no-production-mutation restrictions.
- [x] Baseline real workerd per-statement profile with >=10k rows and both merge modes.
- [x] Add nullable last_message_sequence and last_message_sequence_count synchronization tag using ALTER TABLE ADD COLUMN; lazy MAX fallback once including stream maxSequence.
- [x] Initialize fresh sessions at zero; combine watermark with existing writer updates; unchanged reporter positions and fallback allocation, with an independently tracked maximum.
- [x] Cover archive import/copy-back/restore and every writer in real-workerd regression tests; concurrency, legacy NULL, absorbed chunks, restart, duplicates and rollback.
- [x] Attribute archiveSourceReclaimPage scans: DELETE checks scan both comment FK children. Local25-message page100127r→127r with indexes, writes25 unchanged. Deferred index deployment to SAM idea01M7GD0KT5D1FERR205E61DYXR: current production category telemetry absent; latest non-null breakdown stale/coarse (unattributed4.87GB), so constructor build safety cannot be proven. User explicitly permits finding-only deferral. No archive reclaim/index change ships; raw import watermark repair does ship.
- [x] Show bounded steady-state reads at 10k and larger fixtures, with production indexes and meter reconciliation; report writes before/after.
- [x] Run lint/typecheck/tests/build and migration safety; all local specialists complete (Cloudflare verified numeric/MAX compatibility then PASS; test engineer PASS; constitution/doc sync PASS; completion implementation A–F PASS). Root lint22tasks/typecheck36tasks/test39tasks/build18tasks passed;75impacted workerdtests passed. First root web teardown flake did not repeat, tracked in idea01M7GE20TDY6BYHRGE38KA097F.
- [ ] Request shepherd bounded Instant/no-VM staging grant (<USD1), then enforced lease and real flow with merging ON/OFF; cleanup.
- [ ] Ready PR + CI + CodeRabbit request/wait, merge gates, production deploy monitoring (read-only), coordinator durable progress and idea notes.

## Acceptance
Reads per warm batch must not grow with session length, with no new per-message sequence index. The stored maximum stays correct across every writer, restore, and merged logical chunks, introducing no new sequence collisions. Existing supplied reporter positions may duplicate/reset; preserve their ordering contract here (separate design idea01M7GFN2B1FFV5T260TZYWMAB2). No storage/archive safety weakening. Production merge toggle/default and VM cadence unchanged.

Part 2 bookkeeping writes follows after this PR; track separately, including exact lifecycle flushes and idle/restart safety with typed admin interval.

Count-tag contract for part2: tag records persisted message_count, not logical live count. Throttled batches leave both count/tag unchanged while watermark and receipts advance durably. Count flushes update count/tag together. Older builds update count without tag, triggering one MAX repair even after restart. Archive raw imports only advance watermark, never certify a stale count tag.

## Local verification completed 2026-11-15
Root API:1023files/15263tests passed (3files/4tests skipped); root web410files/5246tests passed. ProjectData50files/528tests passed. Real-workerd final75tests/8files passed. Full baseline statement counts archived at /engineering/cost/ingest/ingest-before.snap, library01M7GDSGFS6QMFF434H05C7C2R. Task implementation archived after completion validation; release gates below remain explicitly pending and are tracked in PR2765 and local .do-state.md until live verification/merge.

## CI compatibility correction
The first complete CI run failed five existing pagination-ties tests because the initial candidate normalized reporter positions. Kept those fixtures unchanged and restored `msg.sequence ?? nextSeq++` exactly; track the maximum independently for the cache. Differential tests compare real ingest against forced-MAX allocation in both merge modes, checking stored IDs/positions and next allocation after absent, ordered, reversed, duplicate, mixed user/system, fractional, negative and large positions. Generated system IDs are normalized only in the cross-object comparison. Revised local checks and CI must pass before staging.

Scope limitation: the original blanket uniqueness/ordering criterion is not established for sender-supplied duplicate/reset positions. This PR preserves existing behavior rather than changing reporter/merge/archive contracts; completion delta review WARN discloses that gap, tracked as idea01M7GFN2B1FFV5T260TZYWMAB2. Focused unchanged-pagination/sequence14tests and strengthened sequence-model9tests PASS; Cloudflare/test delta reviews PASS. Root lint/typecheck PASS; broader revised checks running.
