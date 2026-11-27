# Archive reclaim-flag test fails when the CI runner is slow

## Problem

`apps/api/tests/workers/project-data-archive-reclaim-flag.test.ts`, test "wakes no clean root object, so slow clean projects cannot starve the candidate batch", failed once on main and passed on a rerun of the same commit with no code change.

The test runs one archive tick with a real wall clock of 600 ms (`tick({ PROJECT_DATA_ARCHIVE_WALL_TIME_MS: '600' })`) and expects it to migrate one session:

```
AssertionError: expected { … } to match object { migrated: 1, failed: +0 }
-   "migrated": 1,
+   "migrated": 0,
 ❯ tests/workers/project-data-archive-reclaim-flag.test.ts:171:19
```

The guard it protects is real: with the guard removed, twelve clean projects each cost a 150 ms listing (1.8 s) and nothing is migrated. But the passing case also depends on the runner finishing one migration inside 600 ms of real time, so a slow runner gives the same `migrated: 0` as a missing guard. The test cannot tell the two apart.

## Context

- Seen on main CI run 46006049699, attempt 1, job "Durable Object Workers shard (2/7)", 2026-11-27 13:29Z, commit 30db3e75a. That commit changed nothing under `apps/api` or `packages/project-data`.
- Attempt 2 of the same run passed. The eleven main CI runs before it were green.
- The failed attempt delayed the production deploy of that commit by about 25 minutes.
- The test came with `tasks/archive/2026-11-12-projectdata-archive-drain.md`.

## Acceptance Criteria

- [ ] The test no longer depends on how fast the runner is: for example, it asserts that no clean root object was listed (the `reclaimListingCountForTest` comparison it already makes) and gives the candidate migration a wall clock that a slow runner cannot exhaust, or it controls the clock.
- [ ] The test still fails when the reclaim-pending guard is removed (delete the guard once, see the test go red, restore it).
- [ ] The file's other tests are checked for the same pattern (a short real wall clock next to an assertion that work completed).
