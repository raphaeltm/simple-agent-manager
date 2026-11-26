# Flaky: selfhost-runtime-secrets "refreshes the rotation read fallback with the new bundle"

## Problem
`apps/api/tests/unit/selfhost-runtime-secrets.test.ts` > wrapDurableObject > a resident object >
"refreshes the rotation read fallback with the new bundle (Codex P1)" failed once in CI
(run 45691341052, job 139477627441, PR #3012): `expected 'k1' to be 'k2'` at line 560, after two
`settle()` calls. It passed 3/3 locally on the same head, and PR #3012 does not touch this code.

## Context
Found while waiting on CI for PR #3012 (self-host umask + usage-limit label). The test waits a fixed
number of `settle()` ticks for an asynchronous bundle refresh, so a slower CI runner can observe
the old key.

## Acceptance Criteria
- [ ] The test waits on the refresh itself (a promise or a deferred the refresh resolves), not a fixed number of ticks
- [ ] 50 consecutive local runs pass
- [ ] The discrimination check still turns the test red when the refresh is removed
