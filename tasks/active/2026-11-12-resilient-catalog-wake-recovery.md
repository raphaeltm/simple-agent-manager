# Resilient compute catalog refresh and sleeping wake recovery

Idea: 01M77P985TDMCJ28JTTQHEYMC7. SAM task 01M77Q6A32CJRZAE06QE8NH1YJ.
Coordinator task 01M77NV1B621TKTV79272F7YX3. Sol / openai-codex.

## Problem and authorization

An established pool became migration-pending mid-refresh, hiding validated capacity and permanently refusing a healthy sleeping conversation's accepted wake. All four changes are approved: retain committed capacity safely; durably continue refreshes; preserve retryable wake intent; test interruption/restart/recovery. Additional evidence: harmless pool revisions reject still-authorized existing nodes.

DRAFT PR only pending coordinator review of full final SHA. Do not disturb original production conversation 113a693f-8f1c-4b3f-88d8-69fa1ee4ab91, stable task 01M72KTXWD8FJ0Z7TXKN5GF20J or snapshot. Real staging required; no production lifecycle fixtures.

## Preflight / research

Classes: cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change.
Data flow: scheduled/capacity-pool-reconciliation -> default-capacity-pools-read/ensure -> fenced D1 source/candidate publication -> summary -> placement resolver/authority -> session-recovery -> snapshot claim/TaskRunner -> ProjectData durable prompt delivery -> ready handoff.
Existing cursor persists every batch, fences obsolete source generations; current publication mutates live candidates before completion. Daily gate claims before work and cannot resume unfinished refresh promptly. Current refusal classification already supports transient retries; preserve these mechanisms and delivery TTLs.
No new external API/dependency/framework planned. D1 additive migration, real SQLite tests, existing D1 batching. Existing interruption/fencing tests retained. Source/credential/current membership remains live authority. New allocations retain strict revision fences; existing-node reuse must revalidate against current authority.
Concurrent #2682 extraction keeps D1 worker-side; pure placement files move to scheduler-core after integration #2681. Coordinate and rebase on latest main.
Existing backlog: 2026-11-09-capacity-pool-readiness-gate-during-republication.md. Prior archive: 2026-11-09-capacity-pool-publication-deadline-loop.md.

## Implementation checklist / acceptance

- [x] Stage complete replacement candidate sets durably; atomically promote with generation/ownership + current membership fences; no mixed live set or premature missing cleanup.
- [x] Persist trustworthy pool publication proof; bootstrap stays gated, established refresh retains placeability through interruption/failure. Immediate revocation/source disable/removal remains enforced.
- [x] Durable retry next action + started/last-success/deadline; resume independent of daily gate and after lost notification/restart; shared pass budget bounds all sources/scopes; actionable exhaustion retains committed catalog.
- [x] Admin-editable settings and documented latency/throughput at 7,200-row catalog and many scopes.
- [x] Typed temporary catalog/lookup/capacity wake waits; impossible resources/configuration/credentials remain accurate outcomes; accepted message/event identity and TTL/cancel authority preserved.
- [x] Existing runtime safe revalidation after pool revision, through real selection and final admission; strict stale-allocation and revocation guards remain.
- [ ] Real entry-point regression tests: bootstrap/established, changed/unchanged, multi-batch restart, failed promotion, concurrency/stale publisher, lost continuation, 24h independence, membership/revocation, wake automatic recovery/cancel/TTL/no duplicate authoritative handoff.
- [ ] Docs synced; focused + full quality checks pass.
- [ ] Local Cloudflare, security, test, constitution, documentation and task-completion review completed and addressed.
- [ ] Real coordinated staging VM chain verified, Instant compatibility retained, resources cleaned.
- [ ] Draft PR/CI/best-effort CodeRabbit evidence; coordinator final diff + full-SHA gate.

## Evidence

Pending. No release authorization for a concrete SHA yet.

## Latency and throughput budget (rule 81)

Defaults: a dedicated one-minute continuation cron, eligibility backoff of 15 seconds doubling
to at most 60 seconds, a 180-second crash lease, a 20-second shared wall budget per pass, a
20-second per-source publication budget, and a 120-minute absolute refresh deadline. All work
budgets/backoffs/deadlines/leases are admin-editable; the lease is clamped to at least the shared
pass budget. Eligibility is not delivery: work runs on a subsequent cron tick, and a crashed
claim waits for lease expiry. Provider requests already in flight can overrun a pass budget;
later sources/scopes defer durably. Ordinary daily catalog discovery remains separately gated.

At the outer probable catalog size of 7,200 materialized candidate rows per source and the default
200-row batch, replacement needs `ceil(7200 / 200) = 36` staging batches, approximately 36 durable
cursor writes, and one fixed promotion transaction: about 73 write round trips per source.
Promotion is a fixed set of SQL statements, not another per-row batch. Assuming 0.5 seconds per
D1 write round trip gives approximately `73 * 0.5 = 36.5` seconds per source before reads,
catalog fetches and other overhead. This assumption is not a measured result.

Discovery pages contain up to 25 users + 25 projects + installation by default (51 scopes);
the configurable maximum is 200 users + 200 projects + installation (401 scopes). With one
changed 7,200-row source per scope, the default page represents `51 * 36.5 = 1861.5` seconds of
write round trips. At 20 seconds of shared work per minute, the idealized throughput estimate is
`1861.5 / 20 = 93.075`, or roughly 93 minutes. Reads, provider fetches, promotion processing,
partial-pass scheduling and other overhead can make actual completion take longer, exhausting
the default two-hour deadline visibly if they exceed the remaining budget.
The same optimistic calculation for 401 scopes is `401 * 36.5 / 20 = 731.825` minutes (about 12.2 hours),
well beyond the default recovery deadline. Multiple changed sources per scope multiply the work;
larger/slower workloads may also exceed the deadline. They must fail visibly while retaining
committed capacity, rather than silently extend the deadline or promise completion.

A successful bundled/static reference catalog explicitly validated by the producer can publish
known offerings atomically without claiming an exhaustive live inventory. Failed static fallback
and partial API catalogs remain private. Missing-offering cleanup always requires complete API
enumeration as well as completed publication.

Staging measurement of provider fetch, staging batches, cursor persistence and promotion latency
is pending. Record measured timing and the tested catalog/source/scope counts with the final
staging evidence; revise estimates if those measurements differ materially.


## Implementation evidence before full release gates

- Catalog publication/continuation ownership suite:202 focused tests passed, plus actual0236 upgrade/adoption regression passed after seeding pre-upgrade complete/pending pools.
- Wake event chain:25 real Workers +63 unit tests passed, including held restore/handoff and original accepted identity; human user_followup variant in progress.
- Existing-node current-authority fix:176 focused unit +3 Workers admission tests passed, pushed83757a984.
- Cron/uncertain allocation/Instant compatibility:93 tests passed (45 Node +48 Workers).
- Full repository lint14/14 and typecheck20/20 passed before final audit additions; final full test/build and repeat affected checks pending.
- Local review findings fixed in catalog: atomic pool revision+candidate promotion, failed/partial API gating with distinct trusted-static validation, exact claimed generation handoff, disabled authority preservation, malformed scope failure, discovery cursor after durable queue, and finite visible exhaustion.
- Completion audit identified remaining visible UI error notice and premature public chat activation before handoff. Both are being fixed with focused tests/visual audit; no archive or readiness claim until those pass.
- Staging ownership cleared by secret-collection task; deploy/lifecycle/cleanup pending. PR must remain draft for coordinator exact-SHA review.
