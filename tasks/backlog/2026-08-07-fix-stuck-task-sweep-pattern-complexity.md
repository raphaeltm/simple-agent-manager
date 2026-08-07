# Fix stuck-task sweep pattern complexity failures

## Problem

Production observability shows the `stuck_tasks` scheduled sweep failing every five
minutes with `D1_ERROR: LIKE or GLOB pattern too complex` since 2026-08-06. This removes
an independent reconciliation safety net for tasks whose Durable Object lifecycle is
stuck or missing.

This was discovered while investigating production session
`696a21e7-84d1-4080-9060-a77302a7ffc9`. It is separate from the incompatible-agent
cleanup race and must not be folded into that urgent hotfix without tracing the exact
failing statement first.

## Research Needed

- Identify the exact D1 statement and input that produces the pattern-complexity error.
- Determine whether the failure shares a cause with
  `tasks/backlog/2026-05-06-search-messages-pattern-too-complex.md` or is an independent
  SQL construction bug.
- Verify per-sweep error isolation still allows all later scheduled work to run.

## Acceptance Criteria

- The production-shaped stuck-task candidate set no longer produces a LIKE/GLOB
  pattern-complexity error.
- A regression test fails against the current statement and passes with the fix.
- The sweep remains bounded and preserves active/recoverable tasks.
- Production observability shows successful `stuck_tasks` sweeps after deployment.
