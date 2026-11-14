# Archive CI flake evidence (in progress)

Initial phase timings are in `initial-profile.json`. Temporary profiling added `performance.now()` boundaries around fixture/migrations/refusal, preparation, copying, seal validation, all 24 paging variants, tools/search, default-size recovery, and negative reads; no clocks or production operations were mocked. The temporary instrumentation was removed before the source change.

The compact case retains 100 rows and 200 KiB metadata per row, a 30-second timeout, all paging variants, streaming cursor guard, real R2 compression/hashing/sealing and default-size recovery. The added assertion explicitly requires multiple raw compact objects.

Normal phases totaled about 2.6 seconds. Coverage with two busy processes on the same two CPU cores took about 5.7 seconds. Eighteen busy processes on two cores reproduced the unchanged 30-second test timeout: copy alone grew from 0.93 to 10.63 seconds. This is a controlled contention experiment, not a claim that CI had exactly eighteen busy processes. CI logs prove Turbo started coverage across 22 packages; Turbo defaults to up to ten concurrent tasks, and each Vitest package creates its own worker pool. The workflow now serializes package tasks while preserving each package's file parallelism. Full CI duration must still fit its existing 45-minute limit.

The lifecycle list already sorts by timestamp then ULID. ULID suffixes are random within a millisecond; the test's causal insertion-order assumption was stronger than the listing contract. Both real handoff decisions and the matching handoff detail remain asserted.

Outstanding: final guard mutations, 30 normal + 30 loaded full-file runs for each affected test file, broader checks, local reviews, draft PR, CI and CodeRabbit gate. No claim of final stability yet.
