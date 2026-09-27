# Fix VM admission wake-up user filter

## Problem

`wakeVmAdmissionWaiters()` joins `vm_task_admissions` to `tasks`, but its dynamic
filters use bare column names. Both tables have `user_id`, so the user-scoped
wake path fails with `SQLITE_ERROR: ambiguous column name: user_id`. Queued VM
tasks then wait for the slower retry timer instead of being nudged when a node
becomes ready or warm.

## Research findings

- Production Workers telemetry confirms the failure on `sam-api-prod`:
  - `2026-09-23T01:32:25.345Z`, event
    `node_ready.vm_admission_wakeup_failed`, node
    `01M35Y467PKDVRMP4NB5MZMPYZ`, error
    `D1_ERROR: ambiguous column name: user_id at offset 207: SQLITE_ERROR`.
  - `2026-09-26T05:37:09.307Z`, event
    `task_run.cleanup.admission_wake_failed`, node
    `01M3E34B1BRBM95F7CEZG9V1ZD`, same D1 error.
- The failure is caught so node-ready and cleanup work can continue. Both catch
  sites log the error at `warn`, and the TaskRunner direct-cleanup path logs its
  enclosing failure at `error`. The two affected warning events are present in
  the production Workers telemetry query, so the exception was not swallowed
  or hidden below the observable log threshold. No logging-level change is
  required for this incident.
- All four dynamic filter columns (`state`, `scope_key`,
  `provider_domain_key`, and `user_id`) belong to `vm_task_admissions` and
  should be table-qualified. `ORDER BY enqueued_at` is already qualified.
- The sibling diagnostic and orphan-cleanup statements in the same file do not
  join tables, so their columns are not ambiguous. Qualifying them is not
  required to fix a joined-query ambiguity.
- The existing real-SQLite test only enters through `scopeKey`; it never drives
  the production `userId` wake branch. The regression now enters through
  `POST /api/nodes/:id/ready`, drains its `waitUntil` work, and verifies the
  intended wake plus the foreign-user exclusion.

## Implementation checklist

- [x] Qualify every `vm_task_admissions` column in the joined wake-up query.
- [x] Add a real SQLite regression test that invokes the node-ready route with
      same-user and foreign-user queued tasks, then drains its async wake work.
- [x] Assert the eligible same-user tasks are nudged in queue order and the
      foreign-user task is not nudged.
- [x] Temporarily restore the bare `user_id`, run the focused test, and record
      the expected ambiguous-column failure before restoring the fix.
- [x] Run focused and repository quality checks.
- [ ] Complete specialist review, staging D1 verification, CI, CodeRabbit (if it
      appears), merge, and production deploy monitoring.

## Acceptance criteria

- User-scoped admission wake-up queries execute successfully on a real SQLite
  engine with both joined tables containing `user_id`.
- Only live queued/waiting admissions for the requested user are nudged; a
  foreign-user admission remains untouched.
- Every column in the joined query is explicitly table-qualified.
- The regression test demonstrably fails when the `user_id` qualification is
  surgically reverted.
- Staging evidence shows the corrected joined query executes without an
  ambiguous-column error.

## Discrimination proof

On 2026-09-27, the fixed focused suite passed with 2/2 tests. I then changed
only `vm_task_admissions.user_id = ?` back to `user_id = ?` and reran the same
suite. The route emitted `node_ready.vm_admission_wakeup_failed` with
`ambiguous column name: user_id`; exactly the new route-level test failed
because no tasks were nudged, while the existing scope-key test continued to
pass (1 passed, 1 failed). Restoring the qualification returned the suite to
green.

## References

- `apps/api/src/services/vm-admission-wakeup.ts`
- `apps/api/tests/unit/services/vm-admission-wakeup.test.ts`
- `apps/api/tests/helpers/sqlite-d1.ts`
- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/35-vertical-slice-testing.md`
- `apps/api/.claude/rules/32-cf-api-debugging.md`
