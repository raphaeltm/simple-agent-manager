# Leak-sweep test coverage gaps (follow-up from PR #1245)

> **Reconciliation 2026-09-30 (weekly queue audit): partially shipped; still open.**
>
> - **Shipped:** M1, the `afterId` cursor case that keeps the personal-type filter
>   (`apps/api/tests/unit/services/github-installation-leak-sweep.test.ts:292`, PR #1245).
> - **Still open:**
>   - M2: `makeSweepDb` (same file, lines 40-90) still ignores the WHERE clause. Add a real-SQL
>     test (`createSqliteD1`) proving org rows are never processed or deleted.
>   - L1: two rows with the same `userId` should issue one `users` query.
>   - L3: webhook tests only use numeric ids
>     (`apps/api/tests/unit/routes/github-installations.test.ts:1068-1130`), so the login
>     fallback is untested on that path.
>   - L4: `apps/api/src/routes/admin-github-installation-leak-sweep.ts` has no tests (`limit`
>     cap/floor, `afterId` forwarding).
>   - L2 (optional): the progress log every 25 rows.

## Problem

A late-arriving test-engineer review of PR #1245 (harden github-webhook owner
guard + residual leak-row sweep, merged as `634bb8a3`) found MEDIUM/LOW test
coverage gaps. No CRITICAL/HIGH findings; the shipped behavior is correct and
covered for the happy path. These are coverage-hardening follow-ups deferred
per rule 25 (MEDIUM/LOW may be deferred to backlog).

All 42 existing tests pass; none are source-contract tests.

## Findings

### MEDIUM

- **M1 — cursor (`afterId`) path untested.** The SQL-filter test calls
  `bulkSweepMismatchedPersonalInstallations` with no `afterId`, so it only
  asserts `installationsWhere[0]` equals `eq(accountType, 'personal')`. When
  `afterId` is supplied the WHERE becomes `and(personalFilter, gt(id, afterId))`
  — that composite branch is never exercised. A refactor that drops the personal
  filter from the cursor-path `and(...)` would not be caught.
- **M2 — fake `makeSweepDb` does not filter by WHERE.** The boundary mock always
  returns `opts.installations` regardless of the WHERE clause, so org-row
  exclusion is verified only by asserting the drizzle expression shape, not by
  proving an org row would actually be skipped under real D1 execution. The test
  comment acknowledges this; no integration-level test closes the gap.

### LOW

- **L1 — user `githubId` cache untested.** Two rows with the same `userId`
  should query the DB once and reuse the cached value; no test covers this.
- **L2 — progress-interval log branch (`processed % 25 === 0`) unreachable** with
  current test batch sizes (max 3 rows). Logging only, no control flow.
- **L3 — login-only fallback in `personalInstallationOwnerMatches` not covered
  via the webhook path.** All three new webhook tests supply numeric ids; the
  login-string fallback is only exercised by the pre-existing OAuth/sync tests.
- **L4 — admin route body-parsing untested.** `admin-github-installation-leak-sweep.ts`
  parses `body.limit`/`body.afterId` with defensive guards; none of this is
  exercised, so `afterId` forwarding from the HTTP layer is untested end-to-end.

## Acceptance Criteria

- [ ] M1: add a test that passes `{ afterId }` and asserts the recorded WHERE
      still includes the personal-type filter (composite `and(...)` branch).
- [ ] M2: either make the fake DB filter by `accountType`, or add an
      integration-level test proving org rows are not processed/deleted.
- [ ] L1: add a two-rows-same-user test asserting one `users` query + cache reuse.
- [ ] L3: add a webhook-path test with non-numeric ids exercising the login
      fallback (insert on login match / skip on mismatch).
- [ ] L4: add admin-route tests for `limit` cap, floor, and `afterId` forwarding.
- [ ] L2: optional — exercise the progress-interval log with a >25-row batch.

## References

- PR #1245 (merged `634bb8a3`); sweep service
  `apps/api/src/services/github-installation-leak-sweep.ts`; route
  `apps/api/src/routes/admin-github-installation-leak-sweep.ts`; tests
  `apps/api/tests/unit/{services,routes}`.
- Rule 25 (review merge gate — MEDIUM/LOW deferral), rule 35 (vertical slice).
