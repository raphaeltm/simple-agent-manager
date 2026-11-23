# Canonical tool-call transcript rows

## Problem
Task 01M7KYS4CDX80CXQ31DVTX54WW; parent 01M7KXHRDQ6C08JCHTRH5R3QQK. Reduce billed DO SQLite writes by updating one canonical tool row per authenticated outbox incarnation/toolCallId. Default OFF; no production test/settings writes.

## Preflight and research
Classes: cross-component-change, business-logic-change, public-surface-change, ui-change, docs-sync-change.
Billable entity: workerd SQL cursor rowsWritten, including indexes; INSERT tool row costs 3, content/metadata UPDATE 1. Preserve grouped search economics rather than multiplying groups per concurrent call.
Sources: idea 01M7HX6F51Z8GYS93PV6XWAFWT updates 01M7KM9VMP6FVFCW55Y117KGYN, 01M7K4ZSKGX5RH41DAMPJW8XAP, 01M7K4WPYC2E3V5RY5CHT38MFB; initial ingest audit matched main a3d3246c0; refreshing against main ebe123927 before candidate review.
Existing persistMessageBatch uses archive mutex and synchronous transaction. MessageStreamBatch has durable source/sequence frontiers, recent UUID receipts and retired sources. Must activate for tool merging independently of text setting. Every tool event breaks assistant run and consumes a logical position/count.
Tool metadata has no start/update discriminator. Within an authenticated outbox incarnation toolCallId identifies one call; replay suppression in session_host_client.go is before all notification handling. New incarnation gets a distinct canonical identity. Deterministic source/incarnation/tool ID hash avoids an evictable locator map and new index; PK is the recovery path.
Materializer combines consecutive tools across pages; mutation behind watermark needs exact grouped/FTS refresh without full-session rebuild. Existing source-archive fences precede writes. Offload stubs require hydration or explicit refusal before mutation; never fallback insert into fenced/owned rows.
Client same-ID merges retain stale rows; lazy cards retain local output. Revision must replace snapshots and invalidate cached/in-flight lazy output. Old readers permanently seal only their session before taking a snapshot; fallback rows also seal mutation to preserve chronology.
Relevant lessons: rules 31, 44, 45, 69 (archive SQL limits/memory), 73 (sparse absence), 17/56 (real-browser visual assertions), 62/35 (real-trigger vertical slices).

## Implementation checklist
- [x] Split affected source modules over 500 lines in a separate refactor commit.
- [x] Add typed default-OFF admin setting and kill switch; preserve exact OFF behavior.
- [x] Deterministic canonical identity, monotonically increasing durable revision, bounded atomic retry receipts.
- [x] Sparse output/title/status merge, terminal monotonicity, missing starts, concurrent calls, source rotation and eviction/restart.
- [x] Preserve notification sequence reservation, logical turn counts and assistant frontier boundaries.
- [x] Refresh indexed grouped text and FTS after indexed canonical row mutation.
- [x] Preserve archive mutex/generation/write fences; handle offloaded rows without stale pointers/proofs.
- [x] Revision-aware web/acp-client merges, logical grouping and lazy output invalidation; old-bundle compatibility.
- [x] Document intermediate-history, sessions_read cursor/count semantics and comment anchors.
- [x] Workerd vertical slices through real ingest for Claude, Codex, OpenCode ON/OFF; assert rows, final snapshots, billed writes and retries.
- [x] Discriminating tests for statuses, late content, source rotation/restart/eviction, archive/offload, materialized mutation and client cache.
- [x] Playwright desktop/mobile stress audit and reviewed screenshots posted to PR.
- [x] Full lint/typecheck/test/build; local specialist/task-completion review; CodeRabbit request/wait and green CI.
- [x] Finish primary staging ON/OFF evidence, cleanup and settings restoration. No DO migration/index added; primary selected for harness credentials. Owner waived live OpenCode after credential exhaustion; retain real-workerd OpenCode coverage.
- [ ] Merge, monitor production deploy, verify setting remains OFF and send counts-only evidence to coordinator/channel.

## Acceptance criteria
Every item above is evidenced by automated tests or documented staging observations; no guard relies only on mocks/source strings. No raw production data in evidence. Never merge incomplete gates.

## Verified candidate evidence
- Candidate `7816ecb3fd1190c0d61db01cc12c0f30b93b3f38`: CI run44060687540 attempt2 passed. Three unchanged concurrency/timing tests failed attempt1; their exact files passed locally (96tests), and one failed-job rerun passed. Follow-up idea01M7MK13Y5MSW1T787M47XY90A records the reliability investigation.
- Full local suite:39Turbo tasks,1812passedfiles,26517passedtests (3files/4tests skipped). Typecheck36/build18/lint22 passed. After main refresh:24focused build/type/lint tasks,27real-workerd tests and4Playwright tests passed.
- Real callback and real ProjectData workerd slices cover Claude/Codex/OpenCode ON/OFF, INSERT3/UPDATE1billing, finalstatus/content, durable retries, sparse/terminal updates, rotation/restart, offload/archive fencing and proof invalidation, indexed mutation past5100Unicode rows, bounded journal/reset, RPC budget and row-fault isolation. Guard mutations were verified red, then restored.
- Scoped callback ingest writes OFF→ON:Claude24→20(3batches),Codex16→14(2),OpenCode32→26(4). Raw tool-row writes9→5,6→4,12→6 respectively. These deterministic comparisons isolate equal inputs; live writes/batch also depend on batch size and harness activity.
- Independent constitution/doc/Cloudflare/UI/task-completion reviews passed after fixes. CodeRabbit requested on readiness07:03 and replied rate-limited; best-effort wait gate completed without retriggering.
- Reviewed mobile375x667+desktop1280x800 screenshots cover normal/stress32cards,longUnicode/scriptliteral,empty/error/singlechar,reload and lazy revision replacement. Durable evidence: https://github.com/raphaeltm/simple-agent-manager/pull/2835#issuecomment-6940672985 . No remaining visual issues in the synthetic audit.

## Live staging checkpoint
- Primary deploy44071628381 passed at the candidate SHA; Cloudflare deployed version annotation matched the exact commit and health returned200. Lease queue and archive-migration guard allowed primary: this branch adds no migration/index/tag. Staging2 reservation was released without fixtures.
- OFF:Claude5calls/10toolrows;Codex3calls/6toolrows. All calls completed. Claude retained three synthetic shell outputs; Codex retained its native terminal-reference content shape. Lazy reads nonempty; desktop/mobile each passed2reload checks per harness with0page errors.
- Initial ON status probing omitted the reader capability, deliberately activating the legacy-client seal. Its separate-row result is compatibility evidence, excluded from the final ON cohort. The corrected probes always carry `toolReplace=tool-replace-v1`; fresh ON fixtures are isolated in another project.
- Fresh ON:Claude5calls/5canonicalrows;Codex9calls/9canonicalrows, all completed. Native Codex first turns did not execute tools; a bounded follow-up emitted tools successfully. Revisions and lazy content were retained. Search found5earlier OFF-conversation hits and4earlier ON-conversation hits.
- OFF billing window closed before the separate search-only canary:6persistMessageBatch calls,184rowsWritten,91rowsRead,0alarmWrites (30.6667writes/batch). ON:19persistMessageBatch calls,496rowsWritten,364rowsRead,0alarmWrites (26.1053writes/batch). Different live inputs/batch sizes preclude a causal percentage comparison. Final ON browser audit passed8reload checks across both harnesses and both viewports with0uncaught page errors. The helper scrolls the actual virtualized list to mount tool groups before asserting them.
- Owner decision verified in parent session76025e93-a54b-4559-8a57-47e9a8ca05f0, user message01M7MMRB3RGHFXRY37NRS0YB4G: live OpenCode may be revisited later because its credential is exhausted. The attempted OFF runtime emitted no tool rows and was stopped; no live OpenCode pass is claimed. Real-workerd OpenCode lifecycle coverage remains mandatory and passed.
- Both staging settings restored and read back:tool merging false/unconfigured,usage interval900000/unconfigured. Eight own sessions stopped,three projects deleted;read-only cleanup verification found0remaining ownprojects/workspaces/active nodes. Lease release44078395648 succeeded; authoritative queue check confirms this task no longer holds the lease. No production settings or test writes. Production rollout leaves `chat.toolCallMergingEnabled` OFF; coordinator owns later enablement/counter observation.

## Reconciliation (2026-11-23, weekly queue reconciliation)

- Shipped switched off in [#2835](https://github.com/raphaeltm/simple-agent-manager/pull/2835) (merged 2026-11-17). `toolUpdatesEnabled` still defaults to `false`. Switching it on is part of the open activation in `tasks/backlog/2026-11-14-merge-streamed-chunks.md`.
- Production deploys from `main` have succeeded continuously since then (latest `7d40cfb2d`, 2026-11-23).
- 1 line(s) stay unticked. They are verification or reporting steps that were not re-checked here; this record does not claim them.
