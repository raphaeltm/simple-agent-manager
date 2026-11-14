# Fix completed container rollouts timing out on stale application lists

Owner: SAM task 01M7D6NKG8E8R7SFTEVTAVWS85. Branch: sam/fix-container-rollout-wait-avws85.

## Problem and evidence

Production run 43601089742 timed out despite pinned rollout 62e4dcbe-fba3-4253-91dc-1d6321ad39ba completing target 1141 at 100%. Read-only production API verification at 14:23Z reproduced list version 1140, application GET version 1141 (success:true, result is an object), and completed rollout target 1141 with both steps completed, final 100%. No configuration/secret payloads retained.

Condition: the pinned rollout has completed every step through 100% at its target.
Signal: application-list version equality with that target.
Divergence: Cloudflare's list remains at N-1 after the rollout and detail GET reach N; during rollout even detail GET can lag. Completion must derive from the pinned rollout, never either version alone.

Use the rollout as authority; retain application version checks for regression and positive supersession evidence. Log stale-list/target disagreement after completion. No detail GET dependency or additional polling calls needed. Existing first-create and metadata-only behavior stays intact.

## Checklist

- [x] Inspect original task research and rule74; verify real endpoint response shape read-only.
- [x] Add HTTP-boundary regression with list N-1/detail N/completed target N; prove it fails pre-fix.
- [x] Remove stale-list completion veto; preserve target identity, history, failure states, timeout.
- [x] Cover pending/failed/superseded and unchanged-image retry controls.
- [ ] Run deployment tests, lint, typecheck, build; specialist reviews and completion validation.
- [ ] Coordinate staging slot; exact branch deployment passes rollout step.
- [ ] PR, CI, best-effort CodeRabbit, merge.
- [ ] Watch production through rollout step and successful-deployment record; durable message parent and idea note.

## Acceptance

Completed100% pinned rollout succeeds despite stale list; current version alone never passes pending rollout; failed/cancelled/superseded/unreadable states remain closed and wait remains bounded. No application behavior/deployed content changes. Staging and production workflow evidence required.

## References

- scripts/deploy/container-rollout.ts and .test.ts
- tasks/active/2026-11-14-container-rollout-completion.md
- .claude/rules/74-proxy-signals-must-match-the-condition.md
- https://developers.cloudflare.com/containers/configuration/rollouts/

## Validation evidence

- Pre-fix regression red at 14:24:54Z: completed new rollout target5, list4/detail5 timed out100ms.
- Post-fix deployment suite: 9 files / 120 tests passed at 14:25Z, including pending/current-version, failed, cancelled, replaced, superseding, unchanged-image retry, malformed and timeout controls.
- No endpoint implementation added: verified GET object shape is fixture evidence only; rollout authority avoids another stale proxy and extra API calls.

## Specialist review evidence

| Reviewer          | Status | Outcome                                                                                                                                                                                                                                  |
| ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| rollout_review    | PASS   | Cloudflare + constitution: completed pinned rollout remains authoritative; all identity/history/supersession/failure/timeout checks preserved; no new API dependency, secret logging or tunables. Independently passed 36 rollout tests. |
| completion_review | PASS   | Completion validator A–F and test engineering: local implementation/coverage complete, discriminating HTTP regression confirmed, no findings. Staging/CI/release remain explicit pending gates. Independently passed 36 rollout tests.   |

- Full build passed (18/18 tasks); targeted script ESLint and TypeScript check passed.
- First full repository tests aborted on unchanged infra DNS/KV beforeAll 10-second hook timeouts during broad concurrent checks. One bounded lower-concurrency full retry started; not claiming full-suite green.

- Full lint22/22 and typecheck36/36 passed. Documentation scan found two stale descriptions requiring application version equality; synchronized self-hosting guide and staging reference to rollout authority.
