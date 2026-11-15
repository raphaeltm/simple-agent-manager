# Staging lease

SAM task: 01M7G56GV78W26KKVN45P8BTEJ; approved design 2026-11-15.

## Problem and research

Staging live checks outlive deployment jobs; no active run plus five minutes is not a release. Use the serialized deploy-staging workflow and GitHub deployment records filtered by environment and dedicated task. GitHub supports deployments: write on workflow tokens and payloads; prove live before merge. Existing permission guard must permit only the lease job's deployment writes. Other jobs, including audit-only paths, must depend on lease success. Reusable deploy and CI workflows belong to siblings.

## Checklist and acceptance

- [x] Lease decision and API script: missing/free, foreign active refusal, expiry takeover, self renewal; malformed/API errors fail closed.
- [x] Environment-keyed serialized workflow preflight with configurable expected deploy time, default/capped hold and optional SAM task ID.
- [x] Same-workflow holder-only release and acquire-only path for bounded checks without full redeploys.
- [x] Unit and integration tests; permission/gating verification.
- [x] Update staging docs, Codex skill summary, and full reference: read/acquire/release, expiry wake rather than chat/poll.
- [x] Local specialist reviews and affected checks; full CI green.
- [x] Live workflow-token/gh read proof, acquisition, refusal, renewal, release, expired takeover; one full staging deploy plus bounded lease-only checks; release after verification.
- [x] Open PR, request CodeRabbit, resolve findings, and add usage note to idea 01M7FYGMEESYH3AJZJ0CT3NKCZ and channel evidence.

References: .claude/rules/13-staging-verification.md and full reference; GitHub REST deployments documentation; idea notes read 2026-11-15. Existing isolated SAM branch used without a redundant worktree. Task tracked on this branch to avoid a separate main commit triggering unrelated pipelines.

## Verification evidence

- Local full lint/typecheck/test/build PASS (39 Turbo tasks; API 15263 tests, web 410 files); focused final review fixes: 24 workflow tests including 11 lease tests and ESLint PASS.
- Local security/constitution/completion review PASS after production-case, pinned CLI, and CodeRabbit fixes; docs/test specialist PASS.
- Workflow-token create/readback and agent gh read: run43744989265, deployment7807631106.
- Foreign actual deploy refused in4.3s: run43745142319, exact holder/task/expiry reported; no deploy job ran.
- Same-holder deployment renewal and full deploy: run43745189203 SUCCESS, lease expiry19:10:25Z;12Playwright smoke tests PASS,1opt-in skipped.
- Early release: run43746687498 SUCCESS, deployment7807959480 released18:32:54Z.
- One-minute reservation43747421498 expiry18:34:45.875Z; wake6d4992e0 accepted/admitted but delivery deferred while turn active. One post-expiry read in active turn then foreign takeover43747655208 SUCCESS, deployment7808002286.
- Final contender release43747780656 SUCCESS, deployment7808019196 released18:37:33.669Z. No second full deployment; no VM/resource fixtures created. Free-slot evidence sent to both channels and waiting owners/coordinators.
- Idea usage note01M7G6NP18SB64A00XNZDJTGGE added. Final merge evidence will be posted there and in the coordination channel.
- CodeRabbit review5912203347 returned4 valid findings. Fixed secondary legacy-audit preflight, strict UTC/calendar expiry, and permission guard string/null overrides. Regression tests and independent review PASS. Final incremental review/CI and authorized merge remain release gates, tracked in PR2762 and local .do-state.md.

## Release gate (tracked in PR)

Implementation and live acceptance are complete. The authorized merge follows only after the final review-fix commit passes CI/Sonar, the incremental CodeRabbit wait completes without unresolved findings, and main/shared-doc changes are reconciled. This task record does not assert a merge before that receipt exists.
