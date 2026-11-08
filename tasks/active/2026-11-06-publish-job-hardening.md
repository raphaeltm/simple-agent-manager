# Harden deployment publish jobs

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
- [ ] Full checks, specialist reviews, staging VM binary refresh and success/cancel/sweep/Instant verification with cleanup.
- [ ] PR, CI, CodeRabbit, merge, production smoke; idea update with PR.

## Scope
No context bundles, executor columns, queueing, or job tokens. Current SAM output branch is already isolated; use it. Preserve local .codex/config.toml change.

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
