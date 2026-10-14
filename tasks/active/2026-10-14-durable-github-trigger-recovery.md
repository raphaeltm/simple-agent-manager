# Durable GitHub trigger recovery

## Problem and scope

Signed GitHub ingress ACKs asynchronously; handler permanently claims ID before downstream success. Same-ID replay cannot recover. Code-backed risk; no confirmed production loss. Scope only audit follow-up item 1 from draft 01M4TBZJTKH78R14RQNNKC837N. Lifecycle/scope/form follow-ups remain in that draft. Prior investigation 01M4RCRVC3ACDYYZ2ZV3739580 shipped PR2327/2328; no duplicate recovery implementation.

## Findings

- `github-webhook.ts`: waitUntil ACK before durable trigger intake.
- `github-trigger-handler.ts`: INSERT OR IGNORE permanently excludes routing retry.
- `trigger-admission.ts`: random execution identities; recovery must reserve one execution per delivery/trigger atomically and reuse it.
- `trigger-submit.ts` / reserved-task-submission: existing execution-derived task identities/checkpoints and TaskRunner startup confirmation. Reuse this boundary; never mint another execution after uncertain submission.
- Existing cron sweep isolation and cleanup can host bounded recovery without a new service.
- Migration rule31 forbids FK-parent table recreation; use additive schema only.

## Checklist / acceptance

- [x] Reproduce postclaim routing failure and same-ID lost replay with synthetic signed ingress and real SQLite.
- [x] Persist bounded verified intake before ACK; failures must return non-success.
- [x] Recover intake through existing scheduled sweep with token leases, bounded retry/backoff and crash recovery.
- [x] Per-trigger stable execution admission/recovery prevents duplicate consequential tasks across races, expired leases, partial multi-trigger success and post-submit crashes.
- [x] Preserve scope/filter/kill switch/authorization/admission semantics; no new credentials or permissions.
- [x] Nonblocking serial background recovery with a between-candidate wall budget; bounded failing/null-lease candidates converge and existing throttled operator alerts report exhaustion.
- [x] Bounded payload retention and dedup retention; exhausted/expired outcomes observable with safe metadata.
- [x] Real SQLite integration tests for retries/races/crashes and additive migration fresh/upgrade paths.
- [x] Update docs/config references, run lint/typecheck/test/build and relevant quality checks.
- [x] Local independent specialist reviews incl task-completion/security/Cloudflare/test/config/docs.
- [x] Coordinate and verify pinned staging using synthetic fixtures, cleanup.
- [x] PR exact SHA CI/Sonar/security and best-effort CodeRabbit evidence reported BEFORE merge.
- [x] Wait for coordinator merge clearance; then merge/deploy/readonly production migration/health/config verification.

## Release constraints

No real external user event replay. No production synthetic canary without existing separate clearance. No new credentials/security exceptions or bypass gates. Main task-file push deferred by explicit sequencing hold; task on supplied isolated output branch. Archive only after requested acceptance complete and completion validator.

## Historical implementation evidence

The following pre-release checkpoints are superseded by final release acceptance below.

- Old main synthetic regression: 19/19 tests reproduced permanent same-ID loss; no confirmed production loss.
- Latest focused suite: 7 files, 119 tests passed, including 41 signed-ingress cases and 33 real reserved-submission cases. It covers retry/backoff, expired claims, stale owners, multi-trigger progress, admission slots, crash checkpoints, kill switches, payload retention and bounded sweeps.
- Mutation proof: removing the processing-token failure fence makes the precommit overlap test fail; restoring it passes.
- Actual Workers signed ingress: 8/8 passed with the full D1 migration chain. Real TaskRunner duplicate/overlap/lost-ack cases: 3/3 passed.
- Runtime candidate bf8ced6f3: full root 21/21 tasks passed, 19,015 tests including API 12,320 (2 API tests skipped). Lint 13/13, typecheck 19/19 and build 9/9 passed.
- Format ratchet, migration safety/order, context budget, file-size, runtime-state, type-boundary and runtime-boundary semantics checks passed; AST checks had zero errors and existing warnings.
- Quality scripts: 51 files, 710 tests passed. Independent D1 migration-gate tests: 31/31 passed.
- Three independent specialist review groups PASS pinned runtime candidate bf8ced6f325ca1803bd28e5ebf927253f8dd4989. Acceptance remains incomplete until staging, PR gates and coordinated production verification.
- Earlier broad Workers invocation finished 135 files passed / 1 failed, 1,620 tests passed / 1 failed (old signed-route return expectation); corrected fixture and final pinned targeted signed ingress 8/8 pass. No final broad Workers pass claim.
- Recovery uses one serial background loop with a configurable 20-second between-candidate budget and existing throttled operator alerts. One in-flight submission may exceed that budget.
- GitHub configuration uses GH_TRIGGER_RECOVERY_* variables mapped to Worker GITHUB_TRIGGER_RECOVERY_* settings; no new secrets or permissions. Migration 0195 is additive; bounded terminal inbox churn uses the existing migration safety percentage cap.

- Migration test now uses the established SQL asset import pattern, executes migrations and asserts database behavior; no scanner exception.
- Read-only staging observability baseline passed persisted D1 noise checks; Workers telemetry unavailable with403, no credential expansion. Staging hold awaits Pulumi preview completion/explicit coordinator release.

## Final release acceptance

Reviewed final head81d193b798c43ddd1a699b6e3955b9667e2150bc passed21/21 root tasks/19,017 tests (API12,322+2skipped), types/lint/build and actualWorkers8. All three specialist groups passed. Exact-head CI38551778475 and Sonar115818498598 passed. CodeRabbit review5516635152 findings were fixed, evidence replied, and threads resolved; automatic follow-up bot review skipped. Ready evidence was published before merge, including Sonar out-of-order older-report reconciliation.

Final staging38553413721/38555135543 passed:12smoke, browser4pages/health200/zeroerrors, signed same-ID2x200/onecompleted intake/payloaderased/zeroexecutions/nodes. Migration0195/readback/API02efcd74-406c-4023-895c-2e9969dc640f verified. Slot released11:16UTC; all own fixtures/jobs cleaned. Earlier matched SolVM staging proof was cleaned up.

Root cleared production after parser verification at11:34UTC. PR2335 normally merged11:35:07UTC as a6866fafaf016d958b35d2a36a7090c0c39c95d6 without protection overrides or review dismissal. MainCI38557611473 and mainSonar115836991191 passed. Automatic production38559400967 succeeded12:12:30UTC. Migration0195 applied remotely to sam-prod11:58:29UTC; postmigration integrity passed12:02:27UTC; observability database had no migrations. Pipeline reported production API versiondb6c1e38-23ce-45c9-9bfe-b0f037bac9e0 at12:11:16UTC and healthy API12:12:21UTC.

Independent production read-only checks passed12:13:09UTC: health200/healthy, login configuration200, unauthenticated trigger route401, production browser/login surface loaded. No auth session, webhook replay, task, trigger, profile or VM was created. Existing Cloudflare connection could not read production Worker (404/10007), so migration/version evidence is the trusted deployment log rather than independent control-plane readback; no credentials/permissions expanded. Production failure injection/canary remains unverified/paused; local synthetic crash/race tests and staging establish recovery behavior. No natural event-loss claim.

Completion validator passed production acceptance on release evidence. This file remains active pending user completion confirmation under task-tracking rule09; no additional runtime release is needed.
