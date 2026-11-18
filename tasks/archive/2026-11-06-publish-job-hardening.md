# Harden deployment publish jobs

Completed 2026-11-09. Implementation [PR #2582](https://github.com/raphaeltm/simple-agent-manager/pull/2582), merge `cbea10ad6681fc45fbc49d73781c2ddb36ced15c`. Phase 1 is released; idea 01KZ6V37D1QGDR3WN12PSDB0QD remains open for phases2–3.

## Final verification

- Approved source head `315b3e9bc2dd43cde705024261270b9df7788d38`; coordinator final approval event `976ade0b-d505-4859-abb1-0efedda33601`. All actual review findings resolved; final readiness review was rate-limited and its 15-minute wait elapsed without another review.
- [Main CI42536790626](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42536790626) passed, including API, Durable Object and Go suites. Conditional writes have real SQLite coverage, owner controls and committed guard-deletion proofs; the final acceptance-race delta passed 10 tests and both deletion checks. Local API, Go/security, docs and completion reviews passed.
- [Pinned staging42530758912](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42530758912) passed. Normal publish returned starting, succeeded and served public HTTPS 200 with the fixture body. A running 120-second build was canceled and had no release after its original finish time while its source remained alive.
- Prior 32166 heartbeat-survival, killed-job sweep and Instant-gate evidence remains valid: those implementations did not change in 315b. The coordinator explicitly approved that reuse. Fresh source/target agents matched the Worker-required32166 release; deployment reused identical Go source while the API ran 315b.
- Staging cleanup verified: source deletion finalized with explicit terminal proof23:24:02UTC; target runtime termination confirmed23:25:28UTC; all owned tasks/workspace/environment absent, zero active VMs, no settings override, controllers exited0. Browser dashboard/project/settings smoke passed.
- [Production deployment42539170610](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42539170610) completed successfully. At 2026-11-09T00:35:26Z, Cloudflare Worker `sam-api-prod` served version `4d1e4532-3486-4ea3-b996-4080781b8ddb` at 100% traffic with message `commit:cbea10ad6681fc45fbc49d73781c2ddb36ced15c`. Public `/health` returned 200/healthy. Production verification used read-only version metadata and health only.
- Structured production proof: [publish-hardening-production.json](../evidence/publish-hardening-production.json). Sanitized staging proof: SAM library `01M6YQV47QHBCPEMJFVBWHR4AW`; unchanged prior scenarios: `01M6YJC9M7WN8SX1XP1GJJR4HK`. [Final staging PR evidence](https://github.com/raphaeltm/simple-agent-manager/pull/2582#issuecomment-6728669414).
- Follow-ups: ambiguous-response reconciliation idea 01M6YDXQZV64BP1JW4G9AQJ468; persisted heartbeat cadence validation idea 01M6YMS28GHMP1RTW92QBMTN6G. Existing main Sonar Docker install-script finding is tracked separately in 01M6JD1YB5R7HDZ1GD6MS0S350 and predates this change.

## Problem and research

Phase 1 of idea 01KZ6V37D1QGDR3WN12PSDB0QD. Node-owned builds currently have no cancel/watchdog, permit terminal status resurrection and duplicate release submission. Existing attempt column defaults to 1; no executor/schema expansion needed. Release FK means release insertion and conditional job linking must share an atomic D1 batch. Existing cron sweep isolator and typed admin settings provide the required extension points.

## Implementation and acceptance

- [x] Real SQLite tests for scoped atomic cancel, bounded stall/deadline sweep, terminal event rejection, and owner/duplicate/late/attempt release fencing.
- [x] Add runtime settings with DEFAULT constants; isolated bounded scheduled sweep emits lifecycle events.
- [x] cancel_publish tool with durable cancellation before best-effort authenticated VM cancellation; old-agent 404 tolerated.
- [x] Fence release callback using publishJobId/attempt; legacy omissions retain behavior; propagate Go payload.
- [x] Lifecycle events for API starting and failed_to_start; early Instant gate references phase-3 idea.
- [x] Go handler/callback payload tests; delete-guard red/restore checks.
- [x] Docs and channel contracts.
- [x] Full checks, specialist reviews, staging VM binary refresh and success/cancel/sweep/Instant verification with cleanup.
- [x] PR, CI, CodeRabbit, merge, production smoke; idea update with PR.

## Scope

No context bundles, executor columns, queueing, or job tokens. Current SAM output branch is already isolated; use it. Preserve local .codex/config.toml change.

> The following checkpoints are historical. Final verification above supersedes their pending statements.

## Saved verification / review evidence — 2026-11-07

- Implementation saved in e8dfdf8c0; current main merged in 42c24dbf5 without rewriting published history.
- Full repository lint passed: 13/13 packages, existing accessibility/hook warnings only.
- Real SQL suites: 27 tests passed after indexed sweep fix; service suite including generated-query EXPLAIN passed 17 tests.
- Cloudflare/constitution reviewer approved after fixing terminal-history scans. Sweep uses indexed disjoint non-terminal status ranges; reads/sort scale with active jobs, not retained terminal history. Default 25 selected jobs per tick: one candidate query, at most 25 conditional updates and 25 asynchronous lifecycle deliveries; no VM network calls on sweep path.
- Go/security reviewer approved: focused real-handler cancel and publish happy-path tests passed. Optional early eligibility read before volume allocation noted; authoritative transactional release fence retained.
- Test/docs/completion reviewer: no implementation blocker; final validation, mutation proof and staging evidence required before archive.
- Unrelated .codex/config.toml stays uncommitted.

### Foreground recovery verification — 2026-11-08

- Affected API suites passed **73 tests / 7 files** (11.90 seconds). Includes real SQLite service, callback route, scheduled sweep, MCP start/cancel and existing publish regressions.
- Previous long full commands were interrupted by session sleep and their temporary logs disappeared. Their outcome is unverified; rerun gates remain required.
- Full typecheck passed **19/19 tasks** after latest main merge and explicit aliases for atomic event insert-select fields (2026-11-08).
- Focused Go tests `go test -p 2 ./internal/publish/... ./internal/server/... -run 'TestMcpBuildAndPublish|TestPublish' -count=1` passed.
- Broader Go server run fails in existing `TestHibernateReportsQuiescedOnlyWhenCheckPasses` (capture `degraded`, expected `available`). Reproduced all three failures on clean `origin/main` d300ba42b in detached baseline worktree; unrelated to publish changes. Do not claim broad Go pass.
- Latest main consolidated deployment MCP discovery. Added `deployments_write` method `cancel_publish` while retaining direct callable `cancel_publish`, and marked cancellation destructive. Docs retain current grouped publish/status names.
- Default full test worker fanout caused memory pressure. Stopped that run explicitly; replacement uses `turbo run test --concurrency=1 -- --maxWorkers=2` to bound local resources.

### PR / CI checkpoint — 2026-11-08

- PR #2582 opened with durable specialist review evidence and staging explicitly pending, per coordinator request after repeated automatic session sleeps.
- CI on cf85c5108 passed lint, typecheck, build, VM-agent unit/E2E/integration/smoke, preflight and specialist evidence. Sonar flagged implicit string sorting and handler complexity; corrected with explicit comparator, extracted argument helpers, and bounded D1 sweep batch. Follow-up Cloudflare review approved unchanged expiry/terminal guards.
- Post-fix scoped typecheck and lint passed; SQL/MCP affected suite passed 35 tests; empty-page and rejected-history assertions added, service suite passed 18 tests.
- Staging deployment run42499039846 in progress. No test VM/resource created yet. Enabled platform Hetzner compute credential verified; no personal cloud credential required.
- Original guard deletion proofs observed and restored: terminal-event guard, cancel terminality/workspace scope, release attempt/terminal/duplicate fences, Instant gate, sweep heartbeat/cancel race rechecks, acceptance-order guard. Earlier temporary logs did not survive sleep; outcomes were observed in-session. Final restored targeted suite passed73 before Sonar-only refactoring.

### Final implementation validation — 2026-11-08

- Final runtime head d1e03526f0edf01f286861d53507f9f80a64f393 passed all CI: lint, typecheck, build, full Test, all Durable Object shards, Go unit/integration/E2E, smoke, SonarCloud and marketing.
- Fresh guard-removal proof saved in `tasks/evidence/publish-hardening-guard-mutations.json`: ten removed guards each failed the intended test; restored real-SQL/MCP suite passed35tests. PRcomment6724035073 retains the same proof.
- Staging browser smoke passed dashboard, project and settings with zero page errors. Fresh VM heartbeat identifies agent30c80869dcd1dc5974660afdb06a405698f3722b, same Go content as final runtimehead.
- Actual VM publish01M6Y0QT8ZN6ZMZMT6M13FGGRD succeeded and linked release01M6Y0R61D76Q1QN31QFYD8WP1, version1. Delayed job01M6Y0TCKQ1FAK2W5MQ4WN1QSC canceled while building with no release. At16:47 release list still contained only version1. Final API rollout, kill/sweep, active Instant gate and cleanup remain pending.

### Completed live staging and cleanup — 2026-11-08

- Deployment42499959944 succeeded on runtimehead d1e03526f. Browser smoke3pages passed withzero pageerrors. Publish v1 was applied withweb running (appliedSeq1).
- Active Instant session returned the exact VM-session gate and created0jobs. Running delayed build canceled, retained no release beyond its build delay; onlyv1 existed.
- Killed source VM termination was confirmed17:01:57.592Z while job01M6Y1NGTTK3T27K2VT8TZVC70 remainedbuilding. Scheduled sweep wrotefailed/stalled/retryable1/no release17:05:51.170Z, within temporary30second silence threshold plus5minute tick. Last event17:00:36.166Z. Earlier queryprecededtickwrite; no sweepfailure was recorded.
- Temporary setting reset; no platform_settings override remains (default300000ms). D1 cleanup proof17:13:05Z confirmsall3fixture nodesdeleted withterminationproof, environment/profile/tasks absent. Existing project/profile and unrelatednodes retained.
- Full evidence in `tasks/evidence/publish-hardening-staging.json`; mutation proofnowincludes failingtestnames/excerpts. Public defaultstagingapphostnameTLS negotiationfailedfromrunner; appliedservice verified, publicHTTPSresponse remainsunverified. No TLS/routingchanges inthisPR.
- Finalcompletion review approvesimplementation/fourbehaviors, requiresreleaseworkflowbeforearchive. CodeRabbit/merge/productionhealth/finalideanote remain.

### Coordinator correctness review — heartbeat revision

- Coordinator requested changes on1d863927a: progress silence is not executor death; API20min deadline races the later-started VM20min timeout. PR remains draft/needs-human-review, exact new-head approval required.
- Added nullable last_heartbeat_at via additive0227 migration. Heartbeat callback only updates liveness under terminal CAS, not progress/history/status. Legacy null-heartbeat jobs are deadline-only. API deadline30min includes start/callback grace.
- VM emits immediate and configurable periodic heartbeats(default1m), each bounded by existing HTTP_CALLBACK_TIMEOUT. Heartbeat context is canceled/joined before terminal callback. Real-handler silent-runner and blocked-callback tests passed.
- Sweep now sends bounded best-effort VM cancellation after durable failure, in waitUntil alongside lifecycle delivery; cancellation never wakes a sleeping container. MCP and sweep share structured cancellation-failure logging; old-agent404 informational, response bodies omitted.
- Real-resolver cross-language default contract runs in existing combined CLI/Worker CI job; APIregistry defaults passed to exact Go config.Load test, requiring deadline>VMtimeout+5min margin. Local contract passed.
- New SQL regression went red against old predicate(alive+legacy wrongly swept), then21SQL/sweep tests green. Affected SQL/MCP/cancel suites30tests passed; focusedGo config/server publish tests, APItypecheck, scopedlint and agent-context budget passed.
- Still required: mutation proofs for new guards/default margin/heartbeat producer; affected regression suite, specialist rereview, CI, fresh staging silent-but-heartbeating + killed-job tests and cleanup, CodeRabbitincrementalwait, coordinator new-head approval. Earlier staging evidence is historical for pre-heartbeat head and not claimed sufficient for this revision.

### Heartbeat revision guard validation — 2026-11-08 18:27UTC

Twelve revised guard mutations fail at intended assertions: legacy capability, freshness, stall detection, expiry recheck, terminal heartbeat, heartbeat recording, producer, periodicity, API/VM deadline margins, heartbeat/stall margin, and callback cancellation before terminal. Restored real SQLite21tests, default resolver contract, real handler heartbeat tests and focused race tests pass. Evidence `tasks/evidence/publish-hardening-heartbeat-guard-mutations.json`. CI found direct unsupported-volume test fixture missing Config after heartbeat addition; fixture now supplies Config and locks concurrent event collection, focused race green. Staging revision pending handoff from active sleep-2585 fixture; no peer resources touched.

### Coordinator local-history correction — 2026-11-08 18:51UTC

Coordinator re-review verified both high-priority fixes, then found local reporter fan-out still persisted heartbeats and blanked current_step. Reporter now skips heartbeat local persistence; AddJobEvent preserves prior current_step on an empty event step. Real-handler test uses the real SQLite store, exercises stepped build, step-less output, heartbeat and stepped upload, and verifies both prior-step preservation and live stepped updates/history exclusion. Both guard deletions fail the intended assertions; restored focused server/persistence race tests pass. Evidence `tasks/evidence/publish-hardening-local-history-guard-mutations.json`. Revised head CI and fresh staging still required. Coordinator exact-head draft hold retained.
