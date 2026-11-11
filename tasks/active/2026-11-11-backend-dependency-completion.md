# Backend dependency completion — 2026-11-11

## Problem and scope

Complete only PRs #2628, #2629, #2630, #2635, #2637 and #2639 in one coherent candidate. Keep originals open and their branches intact until the verified replacement lands. Candidate stays draft + needs-human-review until coordinator explicitly approves its PR number and full SHA. No resource/concurrency/schedule changes or frontend branch mutations.

## Research

- Fresh 73 associations across both pages, current active tasks and queued tasks: no competing scoped owner. Full PR diffs, reviews, comments and threads inspected; no human feedback/unresolved thread/auto-merge.
- Go consumers: `packages/vm-agent/internal/auth/jwt.go` uses keyfunc's remote JWKS path; keyfunc 3.9.0 adds optional Given/PrioritizeHTTP overrides, 3.9.1 + jwkset 0.11.4 avoid an unknown-kid wait when no HTTP resources exist. Existing HTTPS, algorithm/issuer/audience/node/workspace validation must keep passing.
- `modernc.org/sqlite` 1.62.0 still carries SQLite 3.54.1 and requires exact libc 1.80.1. Go 1.26.10 satisfies Go 1.26.0 requirement. VM persistence consumers include chat, message, MCP stores; run all VM tests/race and both deployment architecture builds.
- `golang.org/x/sys` 0.50.0 supplies Unix filesystem/process primitives; preserve platform behavior and existing MPTCP setting.
- Artifacts repo browser uses `isomorphic-git/http/web`, MemoryFS, clone/walk/readBlob/readCommit/listBranches. 1.44.11's Node HTTP stream fix is distinct from the web adapter; run real tree/diff walk tests and staging Artifacts behavior.
- better-sqlite3 13.0.3 switches to N-API with packaged prebuilds, requires Node-API 10 (Node 22.14+ or Node 24+); root engines expresses those supported lines. Existing CI is Node 22, devcontainer Node 24. Align root engines and local development prerequisites, verify native load and real SQLite adapter/migrations plus full API tests. It is a dev dependency; production D1/DO SQLite is separate.
- Pulumi Cloudflare 6.23.1→6.23.3 upgrades bridge internals; package declares provider plugin version 6.23.3 and SDK ^3.269.0, satisfied by pinned 3.270.0. Review plugin and real staging deployment.
- Original bot npm locks contain unrelated ast-v8-to-istanbul/undici refreshes. Regenerate only assigned upgrades, retain exact target versions and existing unrelated graph.
- Staging owner task 01M72P9NAWTES1V495GRFAAB63 has #2627 window. Coordinate through feature.pr-shepherd-deps-20261111; no overwrite. Fresh VM required to load candidate binary (rule 27); clean up only test resources after verification.

## Checklist / acceptance

- [x] Reconcile scope and ownership before mutation; protect originals as drafts with held associations.
- [x] Apply six upgrades and necessary Node contract alignment; narrow lock diff; early push.
- [x] Install frozen lock; validate native SQLite under Node 22/24 and module checksums/libc pairing.
- [ ] Full relevant lint, typecheck, tests, build; VM race/vet and linux amd64/arm64 builds; Worker tests.
- [x] Local Go/security, Cloudflare/Pulumi, completion/doc/constitution specialist reviews; address findings.
- [ ] Coordinated exact-candidate staging deployment + browser runtime tests; fresh VM heartbeat/access and cleanup.
- [ ] Draft replacement PR links originals, exact-head CI/check URLs, residual findings, CodeRabbit request/wait evidence.
- [ ] Publish readiness evidence; no ready/merge before coordinator's explicit PR + full-head approval.

## Sources

- https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0
- https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.3
- https://github.com/MicahParks/keyfunc/releases/tag/v3.9.1
- https://github.com/MicahParks/jwkset/releases/tag/v0.11.4
- https://gitlab.com/cznic/sqlite/-/blob/v1.62.0/CHANGELOG.md
- https://github.com/isomorphic-git/isomorphic-git/releases/tag/v1.44.11
- https://github.com/pulumi/pulumi-cloudflare/releases/tag/v6.23.3

## Validation evidence

- Implementation pushed at `e532ed7032bf946678ae98db8daec801cb139f49`; frozen install and `go mod tidy`/`go mod verify` passed. Native SQLite 13.0.3 opens and runs transactional SQL under Node 24.22.1 and Node 22.23.4 (SQLite 3.53.4).
- Go/security local specialist review PASS at implementation head: module/toolchain/libc compatibility, remote JWKS refresh delta, strict JWT claims/algorithm checks and x/sys directory security calls unchanged. No introduced findings. Inherited JWKS refresh context cancellation tracked separately as SAM Idea `01M75B2DJRJB3RPW2K106ETMEQ`.
- Workspace restarted during overlapping broad validation; interrupted logs are not treated as passing evidence. Sequential rerun in progress, without changing repository concurrency/resource defaults.
- npm/infra local review ADDRESSED/PASS after the native ABI floor correction; full suites, Worker tests, fresh-VM staging and exact-head PR/CodeRabbit evidence remain pending. Task intentionally active until those gates finish.
- Shared staging owner #2627 updated release estimate to about 14:40 UTC: shared token-login hourly limit delayed D8 until 14:00. Actual cleanup and staging-free notice remain required before deployment; backend then frontend order agreed.

- npm/Cloudflare/doc/constitution local review completed: Pulumi consumed resource Args/State/shared declarations unchanged, optional static exists methods additive; SDK/plugin compatibility confirmed. One native ABI contract finding addressed: package coarse >=22 is insufficient because binding.gyp uses NAPI_VERSION=10; root now ^22.14.0 || >=24.0.0, local development docs aligned. Official matrix: https://nodejs.org/api/n-api.html#node-api-version-matrix .

- Completion specialist checks A/B PASS, D/E N/A: no implementation gaps, eight scoped files and no unrelated surviving package-record changes. C/F remain WARN until local/Workers/staging/VM/exact-head CI gates finish. Task remains active, not release-ready.

- Full `pnpm exec turbo run lint typecheck test build --concurrency=1` PASS at 13:30 UTC: 51/51 tasks successful (10 valid cache hits). API 1079 files/15,894 tests passed, 3 files/4 tests skipped; web402 files/5082 tests passed. Other package tests passed: infra75, providers824, shared963, cloud-init246, terminal105, acp-client586, ui137, installer147, tail-worker30, website102, eslint-plugin16. This run uses a per-invocation limit after the interrupted overlapping attempt; repository defaults unchanged. Formatting check PASS for all modified JSON/YAML/Markdown.
- Native SQLite 13.0.3 transaction also passed on exact Node22.14.0/NAPI10 minimum; Node22.23.4 and24.22.1 were already verified. Go race/vet/all four deployment-platform builds and Workers-specific suite are next, sequentially.

- Race validation found one intermittent scheduling assertion in `TestExpiredEvictionReopensAdmissionAndNextEpisodeParks`: prompt completion can arrive before replay's deferred admission release. Candidate focused10 failed once; clean-main10 plus paired main50/candidate50 passed. This does not prove dependency causation or empirical baseline reproduction. Independent Go/test-engineer review approved a test-only bounded wait on actual admission via the existing `waitFor` helper; permanent fencing still times out and all subsequent stale-episode assertions remain. No eviction runtime logic changed. Focused50 and fullrace reruns required; this small adjacent correction is included solely to finish the real validation gate.

- At `0737a5e7e944511f1e59c80a5dfeaeb043cd0799`, corrected focused race test passed 50/50; full `go test -race ./...` passed (13:49 UTC), `go vet ./...` passed (13:50), and `make build-all` passed Linux/macOS amd64/arm64 (13:52). Builds use resolved content release `e532ed7032bf946678ae98db8daec801cb139f49` and its pinned build date, distinct from documentation/test head. Initial race failure remains recorded above. Workers-specific suite is still running; no pass claimed.
- Final local eviction Go/test-engineer review PASS/ADDRESSED on actual `0737a5e7e` diff. Completion validator PASS for implementation readiness for staging at that head: A/B/C/F pass, D/E not applicable. Staging/VM, exact-head CI and CodeRabbit remain release gates.

- 15:20 UTC: workspace recreated while idle, so the long separate Workers run has no surviving final result and is not counted as passing. Completed checks above remain observed evidence; no interrupted run is promoted to PASS. Current main `5344962e4` merged without conflicts/history rewriting. Draft PR created before staging to run exact-head sharded Workers CI while the shared environment is occupied; no staging/VM exemption. #2627 actual release now estimated 15:50, still wait its notice. CI apt-mirror DNS repair has an independent coordinator-assigned owner; no duplicate patch.
