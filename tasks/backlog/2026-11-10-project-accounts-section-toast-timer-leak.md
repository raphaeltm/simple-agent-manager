# Toast timer outlives project-accounts-section test teardown

## Problem

The web `Test` CI job can fail with zero failing tests. Vitest reports one unhandled error,
`ReferenceError: window is not defined`, thrown from `apps/web/src/hooks/useToast.tsx:43`
(`setToasts` inside `dismiss`), called from the auto-dismiss `setTimeout` at
`useToast.tsx:62` after the jsdom environment was torn down. Vitest attributes it to
`apps/web/tests/unit/components/accounts/project-accounts-section.test.tsx`.

## Context

Seen on PR #2614 (run 42775908287, job 129694480424, head `20c54c04`): 402 files and 5,056 tests
passed, `Errors 1 error`, exit 1. The PR made no web changes, so a pending toast timer from that
test file is leaking past teardown.

## Acceptance Criteria

- [ ] The toast auto-dismiss timers are cleared on unmount, or the test file uses fake timers and
      drains or clears them before teardown
- [ ] A test asserts no toast timer fires after the provider unmounts
- [ ] The web unit suite runs without unhandled errors
