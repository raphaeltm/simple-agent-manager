# Archive CI flake evidence (in progress)

Initial phase timings are in `initial-profile.json`. Temporary profiling added `performance.now()` boundaries around fixture/migrations/refusal, preparation, copying, seal validation, all 24 paging variants, tools/search, default-size recovery, and negative reads; no clocks or production operations were mocked. The temporary instrumentation was removed before the source change.

The compact case retains 100 rows and 200 KiB metadata per row, a 30-second timeout, all paging variants, streaming cursor guard, real R2 compression/hashing/sealing and default-size recovery. The added assertion explicitly requires multiple raw compact objects.

Normal phases totaled about 2.6 seconds. Coverage with two busy processes on the same two CPU cores took about 5.7 seconds. Eighteen busy processes on two cores reproduced the unchanged 30-second test timeout: copy alone grew from 0.93 to 10.63 seconds. This is a controlled contention experiment, not a claim that CI had exactly eighteen busy processes. CI logs prove Turbo started coverage across 22 packages; Turbo defaults to up to ten concurrent tasks, and each Vitest package creates its own worker pool. The workflow now serializes package tasks while preserving each package's file parallelism. Full CI duration must still fit its existing 45-minute limit.

The lifecycle list already sorts by timestamp then ULID. ULID suffixes are random within a millisecond; the test's causal insertion-order assumption was stronger than the listing contract. Both real handoff decisions and the matching handoff detail remain asserted.

Outstanding: final guard mutations, 30 normal + 30 loaded full-file runs for each affected test file, broader checks, local reviews, draft PR, CI and CodeRabbit gate. No claim of final stability yet.

## Repeat progress

Compact full-file runs: 30 normal and 10 CPU-loaded passed so far (520 tests, zero failures). Normal 100-row target median 2649.86 ms, maximum 2967.58 ms. Loaded runs pin the entire test process tree to two cores and keep one measured busy process on each core. The JSONL records positive busy-worker CPU time for every loaded run and preserves every case result. No hidden retries. Lifecycle repetitions and the remaining 20 loaded compact runs are still pending.

Coordinator requires real CI Test-job wall-clock comparisons for serial package concurrency and a middle option before choosing the final budget. Historical Test-job baselines are 32:00 (43585850934), 24:00 (43589298206), and 20:44 (latest successful retry of 43585844985). `ci-budget-comparison.json` currently contains baselines only; proposed serial budget is not final until comparison.

Current additional verification: targeted ESLint and formatting passed, ProjectData typecheck passed, API and its dependencies built successfully (12 Turbo tasks), API typecheck passed after that rebuild, and the full ProjectData package passed 528 tests in 50 files. Loaded compact runs 11–20 also passed; final loaded batch is in progress. Preliminary local specialist reviews are running read-only; no PR is open yet.
