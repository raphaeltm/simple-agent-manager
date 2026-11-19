# Stabilize personal credential limits ordering assertion

Found during runtime-contract validation on 2026-10-07, unrelated to that implementation.

`apps/api/tests/workers/credential-limits-vertical-slice.test.ts` sorts actual references but compares against an unsorted expected pair containing a random hexadecimal suffix. For suffix `f20be0d4`, `owner-elsewhere-f20be0d4` sorts before `owner-f20be0d4`, causing the full Workers suite to fail despite correct membership. An isolated rerun passed all four tests with another suffix; PR2261 CI37610510567 also passed.

Reproduce using a suffix starting after `e` in the personal credentials test. Sort the expected references or assert membership independently of order, retaining exact cardinality and authorization assertions. Validate the file with suffixes on both sides of `e`.

Evidence: `/tmp/contract-workers.log` local full suite 1342 passing, one failing assertion at line199; `/tmp/contract-worker-credential-recheck.log` isolated four passing. No production behavior change is requested.

## Reconciliation 2026-10-12 (weekly queue audit): archived, already fixed

This was fixed before it was filed. #2213 (`57aaa057b`, merged 2026-10-07 17:21:59Z) changed the
expected pair to `[...].sort()` (`apps/api/tests/workers/credential-limits-vertical-slice.test.ts:200`),
and `references()` already sorts the actual values (`:85`). The comparison no longer depends on the
random suffix. The two other multi-element assertions (`:135-138`, `:147-150`) differ in their first
letter, so their order is fixed. #2261 (`ab76c0f42`, 18:06:44Z), which filed this note, already
contained #2213. Archived instead of deleted because
`tasks/archive/2026-10-07-session-runtime-contract.md` links to it.
