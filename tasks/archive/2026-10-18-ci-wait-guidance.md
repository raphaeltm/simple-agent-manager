# Prevent stranded CI waits through accurate guidance

## Problem and research

The GitHub producer appends actions, and ProjectData matches exact event types
and subject IDs. Tool guidance advertised bare CI names; short SHAs also fail to
match. Subscription expiry is not a wake. Stale owner continuations caused repeated
deferral. Existing ownership and release gates must remain intact.

## Scope and acceptance

- [x] Tool schema descriptions and runtime instructions advertise exact completion
      names and full 40-character PR head SHAs.
- [x] Reconcile current checks before registration, immediately after it, and on resume.
- [x] Document independent bounded fallback, expired subscription recovery, and
      shepherd single-owner escalation.
- [x] Add regression tests for advertised filters against the unchanged matcher
      and agent-facing schema/recovery expectations.
- [x] Focused tests, lint/typecheck, context-budget validation and independent review.
- [x] Open PR #2374 with exact validation evidence.
- [x] Apply the authorized shepherd prompt-only correction through `update_trigger`;
      read back unchanged schedule/status/profile/concurrency.
- [x] Complete current-head CI, staging and CodeRabbit review gates, then merge.
      (reconciled 2026-10-26: CI 39111895034 and E2E Smoke 39111895143 success on final head
      `42e37df96`; staging 39111064167 success on `33d3b80df`, which differs from head only in
      this task file; CodeRabbit APPROVED 2026-10-18 09:22 UTC; merged 09:31 as `5b79e6c12`)
- [x] Verify production deployment and basic health/read-only guidance smoke.
      (reconciled 2026-10-26: main CI 39115682602 and production run 39116488528 success; #2374
      "Verified production release" records the Cloudflare version at 100% and a 10:00 UTC smoke —
      health healthy, read-only `get_instructions` returned exact names, full-SHA and fallback text)

## References

- `apps/api/src/services/github-project-event-producer.ts:projectDataEventType`
- `apps/api/src/durable-objects/project-data/project-events-normalization.ts:filterMatchesProjectEvent`
- `docs/guides/ci-wait-recovery.md`

No matcher, security, expiry mechanism or broad CI changes. Four journal PRs are
owned elsewhere. Keep this task active until user confirms completion.

Validation: 36 tests passed in four focused suites; targeted ESLint, Prettier,
API typecheck, dependency builds and context-budget check passed. Independent
completion/docs/API/test review PASS. Live CI wake delivery remains unverified;
no matcher or runtime logic changes.

Current authorization: user superseded draft-only scope and selected #2374 as
the sole canonical release. #2373 is superseded; preserve its branch/history.
Production tests must stay minimal; paid Browser Use is not authorized.
Shepherd prompt saved and read back 2026-10-18 08:29:53 UTC; schedule remains
`0 */6 * * *` UTC, active, with the same profile, concurrency and skip-if-running.
CI/staging/review and merge/deployment receipts will be recorded in the PR.

## Reconciliation 2026-10-26

- Shipped by #2374 (`5b79e6c12`, merged 2026-10-18); first successful production deploy:
  run 39116488528 (head `5b79e6c12`, 2026-10-18).
- Unticked: 0 — none.
- Verdict: ARCHIVE. Guidance, rule pointer and runbook are on `main`, deployed and smoke-checked;
  nothing material left.
