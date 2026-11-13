# Resilient compute catalog refresh and sleeping wake recovery

Idea: 01M77P985TDMCJ28JTTQHEYMC7. SAM task 01M77Q6A32CJRZAE06QE8NH1YJ.
Coordinator task 01M77NV1B621TKTV79272F7YX3. Sol / openai-codex.

Current status (2026-11-13): one coordinator-authorized code-only port to main527f16b9580ad7cd762c60ea7e711175dd843ada is under validation. The current unpublished catalog migration is0239; the0237 catalog references below describe earlier unshipped validation. Main's applied0237_archive_reclaim_pending.sql is preserved unchanged. No staging or release authorization is implied by this port.

## Problem and authorization

An established pool became migration-pending mid-refresh, hiding validated capacity and permanently refusing a healthy sleeping conversation's accepted wake. All four changes are approved: retain committed capacity safely; durably continue refreshes; preserve retryable wake intent; test interruption/restart/recovery. Additional evidence: harmless pool revisions reject still-authorized existing nodes.

DRAFT PR only pending coordinator review of full final SHA. Do not disturb original production conversation 113a693f-8f1c-4b3f-88d8-69fa1ee4ab91, stable task 01M72KTXWD8FJ0Z7TXKN5GF20J or snapshot. Real staging required; no production lifecycle fixtures.

## Preflight / research

Classes: cross-component-change, business-logic-change, security-sensitive-change, docs-sync-change, ui-change.
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
- [x] Real entry-point regression tests: bootstrap/established, changed/unchanged, multi-batch restart, failed promotion, concurrency/stale publisher, lost continuation, 24h independence, membership/revocation, wake automatic recovery/cancel/TTL/no duplicate authoritative handoff.
- [ ] Docs synced; focused + full quality checks pass.
- [x] Local Cloudflare, security, test, constitution, documentation and task-completion review completed and addressed; final release validation remains open.
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
claim waits for lease expiry. Credential preparation, live provider requests and fallback share
the remaining pass deadline; later sources/scopes defer durably. An already-started atomic D1
batch must finish, so the deadline bounds starting further work rather than aborting a transaction.
Legacy upgrade adoption queues at most the configured scope batch size (25 by default) per pass,
skipping already-tracked scopes including exhausted failures. Ordinary daily discovery stays gated.

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
With two changed sources of that size in each of the same 51 scopes (102 sources total), the
same idealized estimate doubles to approximately 186 minutes before overhead, already exceeding
the two-hour default. These are workload sensitivity estimates, not completion guarantees.
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

- Catalog publication/continuation ownership suite:202 focused tests passed, plus actual0237 upgrade/adoption regression passed after seeding pre-upgrade complete/pending pools.
- Wake event/human chain:26 real Workers +63 unit tests passed, including real human prompt acceptance, held restore/handoff, process replacement, automatic cron continuation and original accepted identity.
- Existing-node current-authority fix:176 focused unit +3 Workers admission tests passed, pushed83757a984.
- Cron/uncertain allocation/Instant compatibility:93 tests passed (45 Node +48 Workers).
- Full repository lint14/14 and typecheck20/20 passed before final audit additions; final full test/build and repeat affected checks pending.
- Local review findings fixed in catalog: atomic pool revision+candidate promotion, failed/partial API gating with distinct trusted-static validation, exact claimed generation handoff, disabled authority preservation, malformed scope failure, discovery cursor after durable queue, and finite visible exhaustion.
- Completion audit found a missing visible refresh failure notice and premature public chat activation before handoff. Both are implemented and locally verified: 19 rendered UI tests, 12 reviewed Playwright variants; exact D1/local lifecycle readiness fences, held-handoff/crash tests and durable replay. Final latest-head Workers and release gates remain pending.
- Coordinator budget review: bounded upgrade adoption/failed-known anti-starvation and shared live/fallback provider deadline fixed; six focused tests pass, including real ensure with stalled provider and three interrupted adoption pages. Migration safety/order pass. Unapplied catalog migration reserved0237 because0236_runtime_secret_requests.sql already applied by concurrent PR2688.
- Staging released by secret-collection owner12:44 at3f7ab8f91f3b7fef580fb82fcbf052d1b51e7fc3. Combined staging window coordinated with sibling force-resume task; sole sibling cleanup owner received409 for two old orphan VMs, parent investigating. No new VM/deploy until resource ceiling resolved. PR must remain draft for coordinator exact-SHA review.

## Consolidated validation and current release gates

Main d3204f34d28721ee7af2433180dec6f8d01aa574 merged cleanly, including already-applied migration0236. Catalog migration0237 remains additive and has not been applied by this task.

The full serial local run passed1,052API files/16,020tests and399web files/5,119tests; it failed39API and4web files, partly before fixture corrections and under overlapping load. Every failed file subsequently has a passing focused rerun:134web tests;287catalog/agent-owner tests across14suites;72wake/adapters;453other API tests plus3corrected boundary cases;124archive-sharding/legacy-boundary tests. The original full run remains recorded as failed. GitHub CI43228918905 at a1ecdc461d18123c9bdbe61269c3d490935ef105 subsequently passed its complete Test job, build, lint, typecheck, SonarCloud, UI and VM smoke jobs.

Final full local lint14/14, typecheck20/20 and build10/10 passed. The later source delta also passes actual API typecheck and runtime-boundary semantic validation. Final41Workers passed at a1ec, including the26real human/event recovery-chain cases. Follow-up CI diagnosed four Worker failures, one visual assertion and an unchecked CAS acknowledgement cast; these have concrete fixes and focused evidence rather than suppressed guards:

- CAS acknowledgement now validates its own returned revision/time/status before adopting the guard. Nine damaged-ack controls use real SQLite and preserve concurrent-editor ownership tests;46interleaving tests pass.
- Two eviction-auth fixtures now bootstrap validated bundled catalogs. The actual JWT, ownership, activity and replay assertions remain; all36route-auth Workers pass.
- A normal distinct TaskRunner start can retain an older restore receipt. Admission now proves an independently committed owned current task, owned running VM/agent and exact active ProjectData task/workspace before allowing delivery. It never certifies the old receipt or activates/nudges a chat. Captured node and null-safe workspace callback generation reject a target that changes after lookup. All107focused Node tests initially passed, including four node/generation mutations that failed before the fix; the expanded62real Workers controls (26handoff,26human/event chain,10wake-ready) pass on that delta.
- The folded-chat iPhone14 visual assertion now distinguishes legitimate forward refreshes from older paging. It still requires one initial500row/no-cursor request, rejects older reads before interaction and validates exact forward cursors; existing DOM and later paging assertions remain. The single affected Playwright case passes.

The same captured-target gap was then reproduced in the primary committed-restore path. The resolver now carries an optional captured-runtime expectation through the existing internal readiness input; the shared query enforces it inside the DO activation authority check. Resolver preflight rejects stale captures before activation and rechecks after the RPC before returning the captured external target. A rejected primary proof can only use the read-only historical proof. The nullable rejection/valid duplicate-zero contract remains unchanged. The primary and historical paths also require the current node owner to match the workspace owner. Final129focused Node tests pass across three files, including matched-owner/foreign-owner VM and Instant controls and delayed mutations before and during readiness. Final69/69Workers pass on unchanged source:33handoff/authority controls,26human/event refresh interruption/restart/wake cases and10readiness cases. The run took260.36seconds (setup154.88seconds, tests100.58seconds). D1/DO/external effects do not form one atomic transaction; mutation after the final authority read remains the existing non-atomic boundary, with retries and reconciliation rather than an exactly-once claim.

Final security, Cloudflare, constitution and documentation review of the historical-receipt/node-generation delta passes; the final primary-path delta also passes security/Cloudflare/constitution/documentation review, API typecheck, scoped lint and runtime-boundary semantic validation. Runtime-boundary semantics, file-size/type-boundary/runtime-tunable checks pass. Exact logs remain in .do-state.md and the PR evidence; final consolidated head and fresh CI are pending. Latest main f26ff9e8993be6765a4927613cbf1bf8b12283ce adds unrelated session-details/profile-search changes; no scheduler/ProjectData extraction has merged.

Draft PR: https://github.com/raphaeltm/simple-agent-manager/pull/2693. All12mock Playwright screenshots were reviewed and posted in comment6825123103; no visual issues. The PR was opened early at the coordinator's explicit request so CI can run during the external staging hold. This does not waive staging. The needs-human-review label is the required coordinator-review marker and also records the external cleanup blocker; metadata checks remain blocked until the coordinator releases the review gate and physical staging cleanup is resolved. Preflight body requirements were corrected and the local checker passes.

Real staging has not run and no test resources or deployment have been created. The force-resume sibling is the sole cleanup owner for two pre-existing empty GCP VMs; ordinary deletion returns409 because physical termination cannot be confirmed with the available provenance/capability. Coordinator/human cleanup must be verified before a new VM. Do not duplicate deletion, bypass D1, attest termination falsely, or exceed the shared resource ceiling. A combined validation-only integration branch is coordinated with sibling draft PR2691; final output PRs remain independent.

The original production task/session/snapshot remains untouched. Required real VM lifecycle, measured timing, cleanup, current-head CI, best-effort CodeRabbit and coordinator independent review/approval of the full final SHA remain open. Keep this task active and PR draft; no release or archive claim.

## Coordinator review: authority changes during ProjectData I/O

Independent coordinator review of02c0af540761e7c43351df29492448e7a6b96c5d reproduced a historical-proof race: current D1 authority could change while getSession was awaited. The helper now reuses the complete authority query after that await and adds a mandatory current-task ID predicate, bound to the identical task proved by the initial D1 row and the active ProjectData binding. It cannot adopt a different qualifying task. Captured node/generation, snapshot task/attempt, ownership and committed status are all revalidated; no activation, inbox mutation, new state or RPC is added.

Fourteen discriminating controls fail on the prior head and pass after the fix. Final143focused Node tests pass across three files. Real Workers await-hook controls cover matched positives, valid node replacement, generation/attempt changes, cancellation and transfer of the unique chat binding to another task in both wake modes. They also assert unchanged accepted identity, transcript, retry deadline and attempt state. The expanded81-case Workers run passes (45handoff/authority,26human/event interruption chain,10readiness), taking264.05seconds. API typecheck passes after rebuilding shared types from the latest main; scoped lint, semantic validation and specialist review also pass. The replacement full-SHA coordinator review, fresh CI and required real staging remain pending.

## Current CI and virtualized notice audit correction

At986932589e2c333a40e016825a4f53a7170b9cf9, full CI Test, all three Workers shards and their aggregate, build, lint, typecheck, code quality and VM smoke pass. Visual CI43244021680 fails one of729executed cases: the Desktop system-notice audit waits for a row outside the virtualized window. The unchanged exact case reproduces two failures in three CI-mode repetitions, with the system row absent and Scroll to bottom present. The audit now uses its existing scroll-and-expand helper and retains the explicit accessible headline, complete log, no-card, overflow and screenshot assertions. Both viewports pass three repetitions each.

The requested complete-file run then exposed a second concrete synchronization race: a dynamic fifth locator disappeared during the collapsed-row loop, rather than failing the collapsed-state or height limit. That loop now reads one atomic DOM snapshot and retains both assertions for every mounted toggle, adding a nonempty assertion. A repeated run also reproduced the absent last row before the collapsed checks, so this presentation audit now deliberately scrolls its real conversation to the end before those unchanged checks. This does not verify initial scroll anchoring. No product code, mock content, overall test timeout, global retries or quarantine changed. The test engineer independently reviewed the actual final diff. Final CI-mode complete-file validation passes20/20cases across both viewports and two repetitions (1.2minutes), after the focused6/6expanded-case run. Scoped lint, format and diff checks pass. The original failed CI and intermediate9/10and19/20runs remain recorded; none is represented as green.

The potential initial project-chat anchoring behavior is preserved separately in SAM Idea01M787CPKEVRF6BDWHVY4MZGMS. Existing newest-page project-chat unit tests mock Virtuoso; the real-browser newest-turn check found in the targeted search covers the separate /sam surface. That does not prove the exact project-chat geometry correct. The follow-up carries the unchanged-head reproduction and observed initial-window evidence without claiming a confirmed production issue or expanding this patch.

The coordinator independently closed the historical authority finding at986; this test-only correction requires a new full-SHA review and CI. CodeRabbit was requested once through the trusted workflow and observed for15minutes; quota prevented a review, satisfying the best-effort gate unless a later actual review arrives. Required real staging remains blocked by physical cleanup. Combined28ba validation applies only to old force83plus core986; final integration must include the corrected independently reviewed force head. Keep this task active and the PR draft with its required review marker.

## Current-main package port and migration collision

Main527f16b9580ad7cd762c60ea7e711175dd843ada includes the merged worker modularization and archive4d6fccde2f992fa46679775a1096edb54ebbb090. Its applied0237_archive_reclaim_pending.sql collided with this branch's unpublished catalog0237. Fresh main and force-resume636 inventory reserves peer0238_provider_limit_recovery_scan_index.sql; catalog moves only its unpublished migration to0239_capacity_catalog_publication.sql. Applied archive0237 is byte-identical to main; catalog0239 is byte-identical to the original unpublished catalog migration. The native migration helper now reads0239. The four staged lifecycle harness sources contain no migration filenames or moved implementation paths, so their source needs no port edit.

The twelve merge conflicts were resolved at the extracted ownership boundaries:

- Catalog schema additions live in packages/worker-core/src/schema.ts; apps/api/src/db/schema.ts remains the main compatibility re-export.
- The typed placement failure lives in packages/scheduler-core/src/placement-resolver-types.ts and its curated public entry point. D1 loading, atomic publication and final placement admission remain in the worker.
- Wake activation guard, readiness, session transitions and DO orchestration live in packages/project-data/src/do; the client wake options live in src/client/project-data.ts. API compatibility files retain the main re-exports.
- The existing shared exact D1 readiness query lives in packages/project-data/src/do/session-wake-ready-authority.ts and is exported through the public package entry. The worker re-exports it and retains the historical receipt proof with full post-getSession revalidation pinned to the same current task. Neither query nor its bindings changed semantically.
- SnapshotWakeClaimInput carries optional allowRestored through the existing sessions port for deferred activation. Captured node/generation, local activation token, wake-ready lock, null rejection/valid duplicate-zero acknowledgment and lifecycle emission order are retained.
- Native/Workers tests use extracted public or permitted internal test entry points. All925original test declarations across31modified suites remain. Publication interruption/fencing, refresh-work and continuation-cron tests are unchanged; accepted-wake/handoff suites change import paths only.

The new catalog-publication-current-chain test executes all256actual migrations for a clean installation and upgrades seeded data after applied archive0237 through catalog0239. Both cases pass. They preserve complete archive reclaim/proof rows and existing source/candidate/pool fields, verify selective committed-publication backfill, exercise new private staging/refresh writes and check foreign keys. The peer's0238 is intentionally absent here and remains part of the later separate combined validation.

Local static Cloudflare/constitution/documentation and security reviews find no port regression. Test/completion review confirms retained acceptance coverage; fresh broad/Workers execution and real staging remain separate gates. The initial dependency/API build found two imports still pointing at removed modules; both were corrected to public package entry points and the API build passes. Migration safety (244FKrelationships/zero new violations), ordering and node-pool boundary checks pass. Final validation results, immutable new head, CI and final coordinator review will be recorded before handoff.

- [x] Preserve applied archive0237; reserve unpublished catalog0239 beside peer0238.
- [x] Resolve moved implementation/schema/test conflicts without restoring duplicate worker implementations.
- [x] Add real clean-install/current-main-upgrade migration coverage; retain prior interruption/fencing/recovery assertions.
- [x] Run local static specialist reviews and address import/wiring findings.
- [ ] Finish fresh native/Workers and quality validation on the immutable port.
- [ ] Push current PR head, reconcile required CI and best-effort review evidence, provide full-SHA/port-map handoff.
- [ ] Obtain final independent coordinator code review before one final combined refresh; physical cleanup, required real staging and final release approval remain open.
