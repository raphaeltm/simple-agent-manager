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
- [ ] Reproduce postclaim routing failure and same-ID lost replay with synthetic signed ingress and real SQLite.
- [ ] Persist bounded verified intake before ACK; failures must return non-success.
- [ ] Recover intake through existing scheduled sweep with token leases, bounded retry/backoff and crash recovery.
- [ ] Per-trigger stable execution admission/recovery prevents duplicate consequential tasks across races, expired leases, partial multi-trigger success and post-submit crashes.
- [ ] Preserve scope/filter/kill switch/authorization/admission semantics; no new credentials or permissions.
- [ ] Bounded payload retention and dedup retention; exhausted/expired outcomes observable with safe metadata.
- [ ] Real SQLite integration tests for retries/races/crashes and additive migration fresh/upgrade paths.
- [ ] Update docs/config references, run lint/typecheck/test/build and relevant quality checks.
- [ ] Local independent specialist reviews incl task-completion/security/Cloudflare/test/config/docs.
- [ ] Coordinate and verify pinned staging using synthetic fixtures, cleanup.
- [ ] PR exact SHA CI/Sonar/security and best-effort CodeRabbit evidence reported BEFORE merge.
- [ ] Wait for coordinator merge clearance; then merge/deploy/readonly production migration/health/config verification.

## Release constraints
No real external user event replay. No production synthetic canary without existing separate clearance. No new credentials/security exceptions or bypass gates. Main task-file push deferred by explicit sequencing hold; task on supplied isolated output branch. Archive only after requested acceptance complete and completion validator.
