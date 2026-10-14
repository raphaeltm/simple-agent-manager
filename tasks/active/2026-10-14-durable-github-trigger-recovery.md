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
- [x] Bounded payload retention and dedup retention; exhausted/expired outcomes observable with safe metadata.
- [x] Real SQLite integration tests for retries/races/crashes and additive migration fresh/upgrade paths.
- [ ] Update docs/config references, run lint/typecheck/test/build and relevant quality checks.
- [ ] Local independent specialist reviews incl task-completion/security/Cloudflare/test/config/docs.
- [ ] Coordinate and verify pinned staging using synthetic fixtures, cleanup.
- [ ] PR exact SHA CI/Sonar/security and best-effort CodeRabbit evidence reported BEFORE merge.
- [ ] Wait for coordinator merge clearance; then merge/deploy/readonly production migration/health/config verification.

## Release constraints

No real external user event replay. No production synthetic canary without existing separate clearance. No new credentials/security exceptions or bypass gates. Main task-file push deferred by explicit sequencing hold; task on supplied isolated output branch. Archive only after requested acceptance complete and completion validator.

## Implementation evidence

- Old main synthetic regression: 19/19 tests reproduced permanent same-ID loss; no production-loss claim.
- New signed ingress tests: 38/38 pass, including pending-start retries, stale-owner failure fencing, partial multi-trigger success, marker-write recovery, concurrency slots, exact backoff/cap, bounded expiry/purge and kill switch.
- Actual signed route → real trigger-submit → D1 task/checkpoint → stateful external ProjectData/Runner boundaries: one task/execution/checkpoint/start under expired-lease overlap. Reserved submission suite 33/33 pass.
- Relevant real migration-chain fresh/populated target schemas preserve linked task/execution/audit and foreign keys; 0195 canonical states and unique source identity exercised.
- Existing generic webhook/incident integration fixtures updated to apply 0195; 55/55 pass.
- Initial review findings addressed: pending-start not terminal intake; stale failure cannot overwrite linked task; durable submission-recorded counter and link repair; recoverable failed execution retains admission slot; pre-submit intake lease fence. Final re-review pending.
- Workflow vars forwarded through both existing environment blocks; no new secrets/bindings. Payload expiry/purge timing explicitly includes bounded cleanup lag.
- Migration safety/order and agent-context budget pass. Full suite still running; earlier handcrafted fixture failures corrected and retested.

- Final kill-switch race: disabling after claim keeps intake retryable; 41/41 targeted tests (38 ingress, 2 migration, 1 snapshot) pass.
- Reviewed new inbox terminal-retention churning selector uses existing migration percentage cap and subset-only validation; independent31/31 migration-gate tests pass. No gate bypass.
- Full typecheck19/19, lint13/13, build9/9 passed. Format ratchet passed. First full root test20/21 tasks failed only on6 handcrafted API schema fixtures (66 cases); all6 now corrected and focused92/92 cases pass; full root rerun pending. Worker runtime test emits workerd cross-DO timeout/fixture DNS errors; final result pending and no pass claim.
