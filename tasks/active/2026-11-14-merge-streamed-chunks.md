# Merge streamed agent chunks into fewer Durable Object rows

Task: 01M7E19YHSJ73896Q84ASSGFDN. Branch: sam/store-streamed-agent-replies-ssgfdn.
Research base: main 4bdaaf61f (#2740). Primary checkout only; preserve unrelated .codex/config.toml.

## Approved design and release gates

Canonical first ID for newly merged assistant text rows; existing rows/IDs stay untouched. No packed constituents and no Go rollout dependency. Both VM and Instant keep using the current reporter. Part 1 was posted on idea01M7CX61WVX72T7CFQNRTX0DVM and sent durably before building; the 20-minute window elapsed. Raphaël's approval was independently verified in parent session94875719-4462-4a74-93d4-15b8babb533e, user message01M7E70T17JMHDSVKXKVSXQCAQ, 2026-11-14T23:41:56.647Z.

Approved differences: very long grouped replies can split differently; raw search can match formerly split words. A third accepted difference is: a later timestamped row that belongs inside an already merged time span appears at the merged row boundary. The discriminating workerd ON/OFF test has identical text bytes but 3 versus 2 groups. Acceptance verified in primary user message01M7EB9DX5D5TPTZQAXNB64XGG (1794704193445). Production ON remains a separate human Admin UI action. Frequency not measured; no production raw sampling route is being built or requested. Parent clarified the already-approved raw-search contract (event a6e2cf55-6100-42a9-898b-2b40c0918ec1): before indexing, repeated-term raw hits consolidate (workerd2→1), using the canonical ID/snippet; indexed FTS stays identical. This is difference2 stated fully, not a new release hold. No universal raw-search equivalence claim; the full detail will accompany the human activation request.

Rollout: one coherent server/browser/admin PR with code default OFF, staging ON. After successful production deploy, verify OFF unchanged. Raphaël flips the production admin setting ON after accepting all behavior differences. Observe two hours, then a separate small default-ON PR. Follow-up tracked as idea01M7EACZ8W7KMPXMHXQB8F22NV. No Cloudflare Worker settings API writes. Another task owns the archive cadence/budget wrangler lines; do not touch them.

## Measurement and durable research

- Production read-only inventories: 2,776 distinct published complete checkpoint pairs; exclude 1,013 zero-group inventories. Remaining 1,763 sessions: 4,588,980 raw /332,614 grouped rows. Sample25 (10Claude,10Codex,5olderOpenCode inferred harness):414,898/13,427. These are density proxies, not safe merge savings. The sessions_read raw-row premise was false: it returns grouped chunks even with all roles. Parent acknowledged this.
- Library reports: /engineering/cost/part1.md (01M7E2FX23S46F4Q7JWGTT04CS), /engineering/cost/option-c.md (01M7E31DZB2Z0AQAANT61MN0NV). Idea notes01M7E2HJ64XC4PY2A8HY7J71MK,01M7E35G3PSF9RWW9D3MF92N0C,01M7EANF1QWMGR80JEXV1EXK83.
- Actual workerd Go reporter fixture:2,100 chunks in42batches,1,785 assistant chunks in105runs,105user,210tool, no thinking/plan/system. Physical rows2,100→420(-80%). Source persistMessageBatch cursor.rowsWritten6,615→1,596(-75.87%;3.15→0.76/chunk). Initial all-source ON1,610 included14background writes; regression guard attributes the RPC phase explicitly.
- Reporter timestamp assignment precedes its mutex, so sequence/timestamp inversion exists before this change. Separate follow-up idea01M7EA05Y3K2JKR59P8C4Z9WHS; no reporter fix in this task.

## Implementation map

| Concern               | Implementation / contract                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Merge and identity    | do/message-stream-ingest.ts stages inserts and one append per open canonical row/batch. Only assistant text with null metadata merges. First ID/createdAt/sequence remain fixed; absorbed IDs stay internal. Old rows cannot become open.                                                                                                                                                                    |
| Retry                 | Authenticated workspace/callbackGeneration source via API runtime.ts→client→DO. Positive ordered durable outbox sequence frontier plus bounded complete recent-batch IDs, atomically committed with rows and logical counters. Duplicate IDs refresh receipts to cover failed local DELETE. Invalid/unsequenced legacy inputs insert ordinarily without erasing frontier.                                    |
| Source invariant      | Reporter DB is per-workspace host DB; restart retains it, recreated runtime generations rotate. Snapshot capture excludes host reporter DB and restore primes the reporter. No supported same-generation DB replacement was found. Arbitrary same-generation DB rollback/reset is not proven by this protocol; do not claim it is.                                                                           |
| Boundaries            | Role/kind/metadata/tool/origin/prompt epoch/sequence gap/cap/source change; materialized watermark seals indexed rows. Logical message-count snapshot seals on any intervening writer, including a row with older timestamp. New rows open only at sorted session tail.                                                                                                                                      |
| Runtime settings      | Admin registry chat.messageMergingEnabled=false; maxRowBytes65536 (1KiB–256KiB); recentIds200 (50–2000). Receipt overflow stores individual rows. OFF seals open rows but retains dedup state.                                                                                                                                                                                                               |
| Live stream           | message-append-v1 capability; messages.batch introduces canonical rows, message.append carries suffix/UTF16offset/revision. Legacy scoped/global sockets seal/suppress merging. Browser handles duplicate deltas, stale snapshots, overlapping-tail catch-up and authoritative backward lookup for missing bases.                                                                                            |
| Counters and hooks    | message_count remains accepted logical input count, so caps, D1 summaries, storage-pressure counts and archive estimates keep prior semantics (estimates conservative). Actual archive inventories count physical rows. Attention/reconciliation receive canonical IDs; activity/idle cleanup/summary refresh still run for each accepted batch.                                                             |
| Grouping/search/cards | Existing materializer/FTS consumes canonical content; indexed rows never append later. Ordinary fixture grouped315 and indexed search match. Typed metadata/cards/tools for every harness are unchanged. Long-group/raw-split-word and approved late-timestamp differences above are explicit.                                                                                                               |
| Schema/archive        | Additive078 nullable chat_sessions.stream_ingest_state only; no raw column change or old-row rewrite. Optional ingest metadata travels archive session envelope only when present, preserving final logical activity time without changing frozen hash columns. Raw update triggers continue advancing generation. Existing/mixed sessions remain archivable and exact reads return complete canonical rows. |
| Comments/exact reads  | Existing raw aliases remain valid; newly absorbed IDs never appear in broadcasts/API/hooks. Canonical comment/quote prefix remains stable as content grows. REST/MCP use complete canonical raw rows and existing grouped output.                                                                                                                                                                            |

## Checklist

- [x] Credential name/limits first, read idea/notes/library, Part1 report + durable message + approval.
- [x] Research current main and existing reporter/raw-reader/archive contracts.
- [x] Implement server merge, admin OFF switch/cap, source receipts, atomic persistence, old-row isolation.
- [x] Incremental browser stream, capability fallback, tail/gap/stale snapshot handling.
- [x] Preserve logical counters, attention/activity/idle hooks, typed metadata and existing references.
- [x] Real workerd billed-write guard, replay/rebatch/rotation/failed-DELETE, cap and materializer tests.
- [x] Real archive coordinator exact read/search/copyback with final logical timestamp.
- [x] Browser unit tests and true WebSocket visual audit375/1280 with settled long text, duplicates, reload and stable DOM anchor.
- [x] Expanded callback→client→DO, pre078 upgrade/hash/generation, mixed sender, kill-switch replay and1260physical-row pagination tests green (46 real workerd tests total).
- [x] Full lint/typecheck/test/build (83/83 tasks), migration safety, and discriminating retry mutation checks.
- [x] Local specialists all findings addressed; task-completion implementation review updated, with release gates still outstanding.
- [ ] Coordinated staging VM+Instant incremental stream/reload/comments/row_usage, then resource cleanup.
- [ ] PR/CI/CodeRabbit findings, trusted-main deploy coordination, merge and successful production receipt.
- [x] Human approval of third difference.
- [ ] Production admin ON, two-hour read-only metrics/stream/comment/error observation.
- [ ] Separate default-ON follow-up PR and final idea/durable report; archive task only when all required work is done.

No deployment or external compute resources have been created yet. Expanded workerd tests pass cleanly. Full quality passes83/83 tasks after adapting existing transcript cursor assertions to overlap the growing tail; all5242 web tests, focused51 consumer tests and62 socket tests pass. The added raw-search granularity regression also passes (47 workerd tests across final runs). Branch rebased onto merged runner fix#2744. Shared staging remains occupied; no claim of task completion.
