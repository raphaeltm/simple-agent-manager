# Staging session-task reconciliation repair failures

## Problem

The staging `*/5` scheduled sweep completes successfully, but its legacy taskless
session repair pass currently fails every bounded candidate. This is unrelated to the
R2 retention work that exposed it through live-tail verification.

## Evidence

- Observed on `sam-api-staging` Worker version
  `e3602f6a-0e62-4c7a-a13d-81713908202d` at 2026-08-09T02:40:48Z.
- `session_task_reconciliation.completed` reported `scanned: 25`, `repaired: 0`,
  `errors: 25`, and `residual: 117`.
- Each `session_task_reconciliation.repair_failed` warning reported a failed
  parameterized insert into `tasks` for an existing legacy taskless session.
- The enclosing `cron.completed` event still reported `failedSweeps: []`; the repair
  helper contains per-candidate failures rather than throwing the isolated sweep.

## Investigation checklist

- [ ] Reproduce one candidate against staging D1 using read-only inspection first.
- [ ] Preserve the underlying D1 error/cause without exposing session content or
      credentials in logs.
- [ ] Determine whether stale session fields violate a current `tasks` constraint or
      whether the repair insert omits a required field.
- [ ] Add a real-SQL regression for the identified legacy row shape.
- [ ] Verify a second sweep converges instead of retrying the same candidates forever.

## Acceptance criteria

- Valid legacy taskless sessions materialize or are explicitly classified with an
  actionable terminal reason.
- A completed staging sweep reports zero unexpected repair failures and a decreasing
  residual count.
- Candidate and error handling remain bounded per rule 47.
