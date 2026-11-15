# Measure and reduce ProjectData archive writes

## Problem
The SAM root is at 92% storage capacity. Archive drain must accelerate while reducing SQLite rows written per archived message. Existing #2727/#2729/#2734 are already shipped and out of scope.

## Research
Production partial accounting: about 1.38 writes/message (source reclaim 1.04, target commit 0.34); prepare/export/verify/flip/checkpoints/D1 missing. Compact raw storage is R2; target retains grouped rows and two FTS representations. Existing real-workerd sweep-throughput and compact-archive tests exercise full coordinator, routed reads/search/copyback and injected failures.

## Checklist
- [x] Profile ~2000 production-shaped streamed rows through real ingest/coordinator in workerd, SQL phase/statement, source/target/D1/alarm/KV.
- [x] Quantify grouped/raw bytes and hypothetical coalescing; trace VM reporter.
- [x] Query billed metrics; verify official Cloudflare DELETE/index/DROP/deleteAll semantics.
- [x] Identify effective throughput bound; calculate 4.75M drain and doubled-rate recommendation without production config edits.
- [x] Post Part 1 results to idea and durable parent message before implementation.
- [x] Implement measured highest-yield safe cuts; retain regression write ceilings.
- [x] Prove exact reads, payloads/search, copyback and reset-resume; exceed page/chunk sizes; discriminate new guards.
- [x] Lint/typecheck/tests/build/migration safety, local specialist reviews.
- [x] Coordinate staging; real sweep archive and app readback.
- [ ] PR/CI/CodeRabbit/merge/deploy receipt and production before/after metrics note.

## Acceptance criteria
Measured lower writes/message through the real coordinator; no weakening of verified-copy-before-flip, terminal hashing, generation fencing, reset resumability, post-flip reclaim, copyback, exact reads/search, budgets, circuit breakers or storage pressure protections. No migration table recreation or DROP. Production read-only through exec_with_secrets. No production setting changes. Work in primary checkout/output branch.

## References
Idea 01M7CX61WVX72T7CFQNRTX0DVM; task 01M7DKNVSWXBVWE9ZPSYZCY9GT. Rules 44/47/58/62/69/76/81; packages/project-data/{src/do/archive-sharding.ts,src/scheduled/project-data-archive-sharding.ts,src/archive/write-budget.ts}.

## Measured implementation
Reporter fixture: 2,100 rows, 315 grouped rows, 164,421 content bytes (78.30 bytes/raw row). Hypothetical run-based assistant coalescing saves 1,680 raw rows (80%); no shared semantic message identity exists today. This task does not implement coalescing.

| Warm coordinator phase | Before writes | After writes | After / raw message |
| --- | ---: | ---: | ---: |
| Source prepare | 6 | 6 | 0.002857 |
| Source mark sealed + manifest | 4 | 4 | 0.001905 |
| Source flip | 8 | 8 | 0.003810 |
| Source reclaim | 2733 | 2733 | 1.301429 |
| Target prepare | 14 | 14 | 0.006667 |
| Target commit | 2911 | 2617 | 1.246190 |
| Target seal | 2 | 2 | 0.000952 |
| Target verify | 4 | 4 | 0.001905 |
| Total DO | 5682 | 5388 | 2.565714 |
| D1 | 103 | 103 | 0.049048 |
| setAlarm / DO-KV / Workers KV | 0 | 0 | 0 |

Batching search-document inserts amortizes sqlite_sequence writes: 1260 to 966. Paired document/FTS write statements fall from 630 to 42. Existing transaction still commits documents, FTS, projection progress and chunk receipt atomically. No format, migration, settings or budget changes. Per-statement snapshot is committed; initial schema creation and pre-archive ingest/materialization excluded (warm-shard per-migration profile). Scoped canary excludes constant global-cadence overhead.

Source reclaim already has only three non-delete/FTS bookkeeping writes; verifier has four. Larger grouped-copy removal needs representation-aware terminal hashing, assertTargetComponentsMatch, grouped copyback/rehome export and search repair plus durable layout discriminator. Grouped FTS alone has mixed-old/new cleanup implications; keep it. All grouped/projection indexes have current query-plan consumers.

Throughput recommendation only: interval 540000 ms, daily budget 6000000, factor 2 and wall 60000 unchanged. At 12000 rows per 10-minute effective tick, 72k/hour drains 4.75M in 65.97 hours excluding inflow (36k/hour: 131.94 hours). Fixture reservation is 6476/2100 = 3.08381 per raw row, requiring 5.329M/day at 72k/hour; actual production inventory must confirm headroom. Current 2.4M budget cannot sustain doubling. No production settings changed. Full notes and official CF billing links are on idea 01M7CX61WVX72T7CFQNRTX0DVM, updates 01M7DMSHEZKW7F7W23ZS4B8Q1A and 01M7DNBWR1VM5G3A99YAJGCF8P.

## Verification so far
- Real workerd archive profile, accounting sentinel, coordinator reset, copyback, atomic failure, resumable cursor and compact archive: 5 files / 28 tests pass (including final SQL telemetry guard).
- Go real reporter fixture test passes; repository lint passes (existing web warnings only).
- DO migration safety passes.
- Full lint/typecheck/test/build pass (39 test tasks; API 15,168 passed, 4 skipped). Cloudflare, constitution, doc sync, Go and test-engineer reviews pass. Completion review confirms implementation coverage, with release gates pending.
- Discriminating mutations: removing duplicate-identity consumption fails the atomic duplicate test; removing bind paging fails the real coordinator with SQLITE_ERROR (too many SQL variables); removing occupied-slot diagnostic fails the real sweep test. All three changes restored; final control suite passes: 4 files / 27 tests.
- Staging positive proof: Deploy Staging 43630741691 succeeded at head8197eb52b. Natural global sweep at20:15Z archived session e634a751-ba10-4810-bb66-a6e7a36fa029 (39 messages) to compact R2, published with reclaim_pending=0. Exact full-message SHA256 before/after: 15ede33631686ffce3a3d9edf6e146c102e4cae3f3494b326ed3c165164f2edd. Playwright opened the archived chat with expected content/no page errors; MCP search found that session.
- Staging admin pressure restored to50 at20:21Z (revision56→57). Restored-config pipeline43637050170 atbbd90cf63 is live100% (CFversiondf7c9b8a-0822-440c-bc74-2dc4be326aa4 at20:29:54Z); compact=false / interval1080000 / sessions50 confirmed. Exact39-message hash, Playwright archived readback and MCP search pass again20:35Z. Full workflow passed, including rollout and smoke; shared staging released20:46Z. Final wrangler diff against origin/main is empty; no CF Worker PATCH or GH Environment edits.
- Literal /do VM-path gate: one bounded cx23 (2vCPU/4GB) smoke workspace01M7DVNXJ8801PY66ECPV7K7KJ/node01M7DVNX6J92SWY7EMYTHPTVV6 created20:23Z. Heartbeat20:26:04Z (42seconds after first observed agent provisioning event), authenticated ws-subdomain terminal command and real agent session create/list/stop passed20:38Z. Physical workspace deletion confirmed and node deleted20:39Z; API lists confirm both absent. No fixtures left. No runtime Go changes.
- PR, CI, CodeRabbit, merge, production deployment and clean-window metrics remain pending.
