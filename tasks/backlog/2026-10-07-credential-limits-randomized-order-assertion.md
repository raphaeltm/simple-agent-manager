# Stabilize personal credential limits ordering assertion

Found during runtime-contract validation on 2026-10-07, unrelated to that implementation.

`apps/api/tests/workers/credential-limits-vertical-slice.test.ts` sorts actual references but compares against an unsorted expected pair containing a random hexadecimal suffix. For suffix `f20be0d4`, `owner-elsewhere-f20be0d4` sorts before `owner-f20be0d4`, causing the full Workers suite to fail despite correct membership. An isolated rerun passed all four tests with another suffix; PR2261 CI37610510567 also passed.

Reproduce using a suffix starting after `e` in the personal credentials test. Sort the expected references or assert membership independently of order, retaining exact cardinality and authorization assertions. Validate the file with suffixes on both sides of `e`.

Evidence: `/tmp/contract-workers.log` local full suite 1342 passing, one failing assertion at line199; `/tmp/contract-worker-credential-recheck.log` isolated four passing. No production behavior change is requested.
