# Full SAM Connector

Authoritative design: SAM idea `01M4GJ0W0DS5BTKBM1YW0X5YC8`, project `01KHRJGANBBWGDY1NZ0KVF0D4J`. Implementation child `01M4H0TFBRMW2S5XATMPNZYDXN`. Preserve the idea.

## Constraints and research

User explicitly prohibits merge and deployment. Keep all work on `sam/run-repository-skill-implement-nzydxn`; do not push task bookkeeping to main because it triggers deployment. P0 is owned by task `01M4GVCTT82B9BMJM46GMXH0YX`, PR #2293, and its branch is reused, not reimplemented. Profile/runtime metadata confirms MF'in Astra / gpt-6-astra.

Existing operations are in `apps/api/src/operations`. PAT HMAC authentication is in `routes/api-tokens.ts`; user denial gates in `services/signup-approval.ts`. Existing `cli_operation_receipts` provide permanent intent reservations. Task submission, chat prompting, permissions, stop and project reads must be extracted rather than accessed by loopback HTTP. OAuth must use the approved maintained provider; no handwritten authorization server.

## Implementation and acceptance

- [x] Reuse P0 foundation and incorporate final P0 fixes.
- [x] All 18 catalog operations, membership/capability/session ownership checks inside operations, shared dispatch preserving VM/Instant/quotas/profile/skill selection.
- [x] Official SDK stateless endpoint, legacy and modern protocol support, stable schemas/annotations, structured output/deep links/untrusted text.
- [x] PAT and OAuth bearer authentication, current user status gates, audience binding, scope challenges.
- [x] Atomic read/write/start budgets, write audit with safe summaries, idempotency via existing receipts, provenance.
- [x] OAuth discovery/DCR/PKCE/consent/token refresh rotation/revocation and configurable settings; OAUTH_KV provisioning.
- [x] Mobile/desktop consent, Settings Access and Connected apps, Admin Integrations Connector controls, provenance labels.
- [x] Public guide, self-hosting/env/API references.
- [x] SQLite attack/control tests and guard mutation checks; real MCP client tests; OAuth conformance and full capability flow.
- [x] Lint/typecheck/tests/build, mobile/desktop Playwright screenshots reviewed.
- [x] Independent specialist reviews, all findings addressed.
- [ ] PR required checks green, CodeRabbit requested and any feedback resolved, ready for review.

Scope follows the fully specified and approved P0–P2 Connector. The specification author confirmed P3 toolsets and P4 /sam belong to later roadmaps. Do not claim them implemented without specification and implementation evidence. Staging deployment is prohibited by the current request; document exactly which verification remains unperformed.

## Review and PR evidence

PR: https://github.com/raphaeltm/simple-agent-manager/pull/2294 (no merge/deploy). Independent security/constitution/Cloudflare/docs/completion and test/env/UI reviewers PASS. Final local desktop/mobile Playwright18/18; screenshot evidence published in PR comment6087971171. Review fixed DCR admission, atomic OAuth replay handling, audit allowlists, pagination request races and long-client badge clipping. Full lint/typecheck/build passed; final full-suite rerun and CI remain pending. P0 owner merged #2293; integrate current main without merging this PR.

Final local full-suite validation: `pnpm test`21 tasks pass (API11,842 pass +2 existing skips), `pnpm lint`, `pnpm typecheck` and `pnpm build` all pass. CI in progress; initial preflight wording corrected, migration-execution test setup clarified for source-contract detector.

Actions CI37982405687 passed all applicable jobs (visual228 pass/28 skips). Late Sonar findings addressed with safe URLSearchParams construction and explicit audit sort; independent security re-review PASS, OAuth21 and execution6 tests PASS. CodeRabbit requested20:00 UTC via trusted workflow37984009394; declined115 selected files over100-file limit, no findings. Final fix CI/Sonar and observation window pending.

## Final validation record

- Final Actions run [37984236981](https://github.com/raphaeltm/simple-agent-manager/actions/runs/37984236981) passed every applicable job on `1c3cb3ea7`: lint, typecheck, coverage, build, all three Workers shards, browser tests, CLI, infrastructure, deployment-script validation, quality and evidence gates.
- Local workspace validation passed 18,528 tests (two existing API skips). Targeted final OAuth Workers21/21 and execution6/6 passed after the two Sonar fixes. Independent security re-review passed both changes.
- CodeRabbit requested once through trusted workflow37984009394 at20:00 UTC. After more than15 minutes, no review arrived: the service declined115 selected files against its100-file limit and reported rate limiting. This is the repository's documented best-effort no-review outcome; no unresolved CodeRabbit findings exist.
- No merge or deployment performed. Live external-client/compute validation remains explicitly unperformed under the requester's constraint.
- SonarCloud has not published analysis for the latest fix commit: the PR view still points to95e143822, while `/api/ce/component` shows an older report rejected as stale and `/api/ce/analysis_status` reports no active analysis. This documentation checkpoint provides a fresh push event; do not claim a green Sonar gate until it reports on the latest head.

## Late coordinator review: workspace routing

A delayed coordinator message identified positional bindings in `workspace-adapter.ts`. Current catalog ordering was correct, but future insertion/reordering could silently dispatch the wrong operation. Replaced all13 workspace tool bindings with existing named exports; added a reversed-catalog regression suite asserting each intended operation and alias flags. All13 cases failed before the fix; all287 affected adapter/platform/MCP tests pass after it. Independent reviewer reran42 tests and returned PASS. API typecheck, scoped lint and formatting pass. Final CI/Sonar rerun follows on the same PR; no merge or deployment.
