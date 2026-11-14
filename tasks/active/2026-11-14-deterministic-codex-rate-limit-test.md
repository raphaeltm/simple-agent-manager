# Make Codex rate-limit tests deterministic

## Problem

PR #2722 CI run 43570510620, attempt 2, failed the window rollover assertion with an exact 60-second discrepancy. Web 5,228/5,228 passed. Keep PR #2722 unchanged at coordinator-approved SHA 5b86fdd85ad6a2451c0671532abf4afd7ae7c8f1; do not retry blindly.

## Research

`apps/api/tests/unit/durable-objects/codex-refresh-lock.test.ts` computes its expected minute before awaited SQLite/crypto setup. Production `enforceRateLimit` independently samples Date.now when handling the request. A wall-clock minute crossing changes the expected window. Production resets stale buckets correctly; no production boundary defect established. The adjacent 429 test shares the same clock race.

## Checklist

- [x] Inspect test setup and production rate-limit window selection.
- [x] Freeze only Date within the rate-limit suite and restore it afterward; leave async timers real.
- [x] Cover immediately before, exactly at, and immediately after a minute boundary with strict expected-window/count assertions.
- [x] Run 30 repeated executions including boundary cases and the full file.
- [x] Temporarily remove production rollover guard, prove regression tests fail, restore production source unchanged.
- [x] Run affected lint/typecheck and review completion/testing/Cloudflare implications.
- [ ] Open separate DRAFT PR plus needs-human-review and hand coordinator exact SHA; no staging for test-only change per coordinator.

## Acceptance

Deterministic boundary tests retain strict 429/200, count, and window assertions and detect removal of rollover behavior. Production code unchanged. Validation/review evidence recorded. Coordinator exact-head approval required before readiness/merge; then refresh PR #2722 once for new main merge ref.

## References

Coordinator event 0c278241-6b90-4569-8b77-a3fc10d62102; `/do`; API AGENTS.md; test-engineer and task-completion-validator skills.

## Validation evidence — 2026-11-14

- Full file: 71/71 tests pass; 30 independent full-file process executions all passed, totaling 2,130 test executions (including the controlled boundary offsets on every run). These are controlled-clock boundaries, not claims about OS process launch precision.
- Each repetition includes the exact minute boundary, one millisecond before it, and one millisecond afterward. Exact 200/429, windowStart, and counter assertions remain.
- Mutation: temporarily replaced `stored && stored.windowStart === currentWindowStart` with `stored`. All three rollover cases failed with 429 instead of 200. Production source was restored byte-for-byte and git confirms no production diff.
- API lint and typecheck passed; all 11 API dependency package builds passed. The initially missing generated worker-core schema was resolved by building dependencies before tests.
- Test-engineer and Cloudflare local review: PASS, no code findings. Completion review: PASS after repeated-run and mutation evidence, no findings.
- No production code, public API, configuration, UI, or migration changes. Staging is explicitly exempt for this test-only correction under coordinator event 0c278241-6b90-4569-8b77-a3fc10d62102. Broad repo CI remains required on the PR.

## Incident note

What broke: PR #2722's single retry failed this test with expected epoch 1794642300 versus actual 1794642360; 15,132 other API tests and all 5,228 web tests passed.
Root cause: the assertion computes its window before awaited credential setup; the request samples Date.now afterward. A real minute can change between those reads. Existing correct production bucket rollover is preserved.
Class: uncontrolled wall-clock dependency across asynchronous test setup.
Why missed: ordinary runs within one minute pass; the test did not control the wall clock.
Process fix: suite-local Date control and strict before/at/after boundary cases, plus the mutation proof above. No new standing instructions are needed for this localized test correction.

Delivery remains in progress: draft PR plus needs-human-review, CI, trusted CodeRabbit request/wait, and coordinator exact-head approval before ready/merge. PR #2722 stays unchanged until this correction merges.
