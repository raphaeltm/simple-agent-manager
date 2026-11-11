# Backend dependency completion — 2026-11-11

## Problem and scope

Complete only PRs #2628, #2629, #2630, #2635, #2637 and #2639 in one coherent candidate. Keep originals open and their branches intact until the verified replacement lands. Candidate stays draft + needs-human-review until coordinator explicitly approves its PR number and full SHA. No resource/concurrency/schedule changes or frontend branch mutations.

## Research

- Fresh 73 associations across both pages, current active tasks and queued tasks: no competing scoped owner. Full PR diffs, reviews, comments and threads inspected; no human feedback/unresolved thread/auto-merge.
- Go consumers: `packages/vm-agent/internal/auth/jwt.go` uses keyfunc's remote JWKS path; keyfunc 3.9.0 adds optional Given/PrioritizeHTTP overrides, 3.9.1 + jwkset 0.11.4 avoid an unknown-kid wait when no HTTP resources exist. Existing HTTPS, algorithm/issuer/audience/node/workspace validation must keep passing.
- `modernc.org/sqlite` 1.62.0 still carries SQLite 3.54.1 and requires exact libc 1.80.1. Go 1.26.10 satisfies Go 1.26.0 requirement. VM persistence consumers include chat, message, MCP stores; run all VM tests/race and both deployment architecture builds.
- `golang.org/x/sys` 0.50.0 supplies Unix filesystem/process primitives; preserve platform behavior and existing MPTCP setting.
- Artifacts repo browser uses `isomorphic-git/http/web`, MemoryFS, clone/walk/readBlob/readCommit/listBranches. 1.44.11's Node HTTP stream fix is distinct from the web adapter; run real tree/diff walk tests and staging Artifacts behavior.
- better-sqlite3 13.0.3 switches to N-API with packaged prebuilds, requires Node >=22. Existing CI is Node 22, devcontainer Node 24. Align root engines, verify native load and real SQLite adapter/migrations plus full API tests. It is a dev dependency; production D1/DO SQLite is separate.
- Pulumi Cloudflare 6.23.1→6.23.3 upgrades bridge internals; package declares provider plugin version 6.23.3 and SDK ^3.269.0, satisfied by pinned 3.270.0. Review plugin and real staging deployment.
- Original bot npm locks contain unrelated ast-v8-to-istanbul/undici refreshes. Regenerate only assigned upgrades, retain exact target versions and existing unrelated graph.
- Staging owner task 01M72P9NAWTES1V495GRFAAB63 has #2627 window. Coordinate through feature.pr-shepherd-deps-20261111; no overwrite. Fresh VM required to load candidate binary (rule 27); clean up only test resources after verification.

## Checklist / acceptance

- [x] Reconcile scope and ownership before mutation; protect originals as drafts with held associations.
- [x] Apply six upgrades and necessary Node contract alignment; narrow lock diff; early push.
- [ ] Install frozen lock; validate native SQLite under Node 22/24 and module checksums/libc pairing.
- [ ] Full relevant lint, typecheck, tests, build; VM race/vet and linux amd64/arm64 builds; Worker tests.
- [ ] Local Go/security, Cloudflare/Pulumi, completion/doc/constitution specialist reviews; address findings.
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
- npm/infra local reviewer must finish; full suites, Worker tests, fresh-VM staging and exact-head PR/CodeRabbit evidence remain pending. Task intentionally active until those gates finish.
- Shared staging owner #2627 estimates release at 13:45 UTC after its D3/D8 lifecycle checks and cleanup; actual release notice required before deployment.
