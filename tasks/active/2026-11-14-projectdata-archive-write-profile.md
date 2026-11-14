# Measure and reduce ProjectData archive writes

## Problem
The SAM root is at 92% storage capacity. Archive drain must accelerate while reducing SQLite rows written per archived message. Existing #2727/#2729/#2734 are already shipped and out of scope.

## Research
Production partial accounting: about 1.38 writes/message (source reclaim 1.04, target commit 0.34); prepare/export/verify/flip/checkpoints/D1 missing. Compact raw storage is R2; target retains grouped rows and two FTS representations. Existing real-workerd sweep-throughput and compact-archive tests exercise full coordinator, routed reads/search/copyback and injected failures.

## Checklist
- [ ] Profile ~2000 production-shaped streamed rows through real ingest/coordinator in workerd, SQL phase/statement, source/target/D1/alarm/KV.
- [ ] Quantify grouped/raw bytes and hypothetical coalescing; trace VM reporter.
- [ ] Query billed metrics; verify official Cloudflare DELETE/index/DROP/deleteAll semantics.
- [ ] Identify effective throughput bound; calculate 4.75M drain and doubled-rate recommendation without production config edits.
- [ ] Post Part 1 results to idea and durable parent message before implementation.
- [ ] Implement measured highest-yield safe cuts; retain regression write ceilings.
- [ ] Prove exact reads, payloads/search, copyback and reset-resume; exceed page/chunk sizes; discriminate new guards.
- [ ] Lint/typecheck/tests/build/migration safety, local specialist reviews.
- [ ] Coordinate staging; real sweep archive and app readback.
- [ ] PR/CI/CodeRabbit/merge/deploy receipt and production before/after metrics note.

## Acceptance criteria
Measured lower writes/message through the real coordinator; no weakening of verified-copy-before-flip, terminal hashing, generation fencing, reset resumability, post-flip reclaim, copyback, exact reads/search, budgets, circuit breakers or storage pressure protections. No migration table recreation or DROP. Production read-only through exec_with_secrets. No production setting changes. Work in primary checkout/output branch.

## References
Idea 01M7CX61WVX72T7CFQNRTX0DVM; task 01M7DKNVSWXBVWE9ZPSYZCY9GT. Rules 44/47/58/62/69/76/81; packages/project-data/{src/do/archive-sharding.ts,src/scheduled/project-data-archive-sharding.ts,src/archive/write-budget.ts}.
