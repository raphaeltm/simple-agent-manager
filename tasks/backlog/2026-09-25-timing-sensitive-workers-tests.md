# Two Workers-pool tests race their own alarms under load

## Problem

Two `apps/api/tests/workers/` cases passed and failed on the same code, depending on load:

- `reserved-task-submission-task-runner.test.ts` › "deduplicates overlapping real TaskRunner
  first-start calls before allocation" expected `currentStep: 'node_selection'` but read
  `'node_provisioning'` (line 665): the TaskRunner's alarm advanced before the test deleted it and
  read the status. Failed once in PR #2145's CI (run 36148279292, attempt 1); passes locally 3/3.
- `project-data-storage-safety.test.ts` › "deletes only bounded terminal-session event-log cleanup
  candidates" read `getAlarm()` as `null` right after `alarm()` (line 1703). Failed 2 of 9 local
  runs on `sam/preserve-failed-tasks-work-fn8ba7` (first during a full-suite run), 0 of 6 on
  `origin/main`; the branch does not reach that path (no attention markers, completed tasks only,
  no alarm scheduling changes). The re-arm behaviour it checks came with #2144.

## Context

Found while validating PR #2145 (failed-task work preservation), 2026-09-25.

## Acceptance Criteria

- [ ] Each test owns the ordering it asserts: stop the alarm before the step can advance (or
      drive the step explicitly), and await the re-arm the alarm performs rather than sampling it.
- [ ] Each is run 20 times in a loaded run without a failure.
