# Flaky: compact archive "writer joining a pending PUT resumes on its own timer"

## Problem

`packages/project-data/tests/unit/project-data-compact-archive.test.ts` test
"on celld, a writer joining a pending PUT resumes on its own timer, not on the PUT settling"
failed in CI on PR #2935 (run 44712693647, job "Test other packages", 2026-11-20 09:56Z) at its
`waitFor` helper (line ~767: `expect(condition()).toBe(true)` after 1,000 `setImmediate` turns).
The same suite passes locally and the PR did not touch archive code. Under the coverage-instrumented
CI run, real async SHA-256 hashing can take more than 1,000 immediate turns, so the bounded wait
gives up before the PUT is observed.

## Context

Found while shipping PR #2935 (Overview automation noise). Unrelated to that change.

## Acceptance Criteria

- [ ] The wait is bounded by something that scales with slow CI (for example a wall-clock budget
      with real timers for the hashing phase, or awaiting the digest promise directly) rather than a
      fixed count of `setImmediate` turns.
- [ ] The test still fails if the joiner resumes on the PUT settling instead of its own timer.
- [ ] The suite passes repeatedly under `pnpm test:coverage` with `--maxWorkers=75%`.
