# Fix Instant idle sleep/wake integration test import

## Problem

Main CI run `36463245559` fails in `@simple-agent-manager/api#test:coverage` because
`tests/integration/instant-idle-sleep-wake.test.ts` still calls `getSession` through the
`project-data/sessions.ts` namespace. PR #2170 moved read helpers, including `getSession`, to
`project-data/session-reads.ts`, leaving the vertical-slice test with a stale import. Eleven tests
fail directly or through resulting HTTP 500 responses, blocking main CI and production deployment.

## Research Findings

- The focused integration file reproduces the reported result on current main: 11 failed and 9
  passed, with `TypeError: getSession is not a function` at lines 64, 605, 629, and 663.
- Merge commit `964035544` from PR #2170 introduced `session-reads.ts` and removed `getSession`
  from `sessions.ts`, but did not update this integration test's four call sites.
- Merge commit `397c6f2e5` from PR #2174 does not touch the affected test, the ProjectData modules,
  or `session-sleep-execution.ts`; the failure is attributable to PR #2170 alone.
- Production code already imports the read helper from its new module. The narrow repair is to do
  the same in the integration test while retaining state-machine writes through `sessions.ts`.
- The user requested CI-only validation unless runtime verification beyond CI is necessary. This
  is a test-module import regression and does not require staging.

## Implementation Checklist

- [ ] Import `getSession` from `project-data/session-reads.ts` in the integration test.
- [ ] Replace all stale `sessions.getSession` call sites with the read-module helper.
- [ ] Prove the focused test changes from 11 failures / 9 passes to 20 passes.
- [ ] Run API typecheck, lint, build, the full API suite, and root coverage/main-CI-equivalent checks.
- [ ] Complete local task, Cloudflare/API, and test-quality reviews; address every blocking finding.
- [ ] Open a PR, obtain green CI and CodeRabbit agreement, merge, and monitor production deploy.

## Acceptance Criteria

- `tests/integration/instant-idle-sleep-wake.test.ts` passes all 20 tests on the current main code.
- The full API coverage suite no longer reports `getSession is not a function`.
- The diff is limited to the stale test import/call sites and task tracking.
- Main CI and the production deployment complete successfully after merge.

## References

- Main CI run `36463245559`, Test job `109066912738`
- PR #2170 / merge commit `9640355440d127c39e93af607da75fd39e1c150a`
- PR #2174 / merge commit `397c6f2e58a26524043e6626f05ce5c7ad23e44d`
- `apps/api/.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`
- `tasks/archive/2026-09-28-instant-idle-sleep-wake.md`
