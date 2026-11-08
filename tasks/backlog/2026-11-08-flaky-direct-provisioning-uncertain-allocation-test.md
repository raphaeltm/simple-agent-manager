# Flaky: direct-provisioning-do "resumes a persisted uncertain allocation" test

## Problem

`apps/api/tests/workers/direct-provisioning-do.test.ts` > "durable direct workspace allocation" >
"resumes a persisted uncertain allocation by exact incarnation without issuing another paid create"
failed on main CI run 42521887015 (merge commit `f375bf66`, PR #2590) with:

```
TypeError: .toMatch() expects to receive a string, but got object
  at tests/workers/direct-provisioning-do.test.ts:643:72
  (await vi.waitFor(async () => expect((await f.intent())?.lastError)...)
```

The same test passed in the PR's own CI and on the previous main commit (run 42521511417).
PR #2590 did not touch provisioning or this file, so this looks like a timing race: `lastError`
is read while it is still `null`/non-string, and `toMatch` throws a TypeError instead of an
AssertionError. The TypeError probably also escapes the `waitFor` retry.

## Acceptance Criteria

- [ ] Make the assertion retry-safe (e.g. `expect(typeof lastError).toBe('string')` first, or
      `expect(lastError ?? '').toMatch(...)`) so `vi.waitFor` keeps polling until the error is recorded
- [ ] Confirm the intended `lastError` shape (string vs object) matches the producer
- [ ] Run the file 20x in the Workers pool without a failure
