# Archive CI flake evidence (in progress)

Initial phase timings are in `initial-profile.json`. Temporary profiling added `performance.now()` boundaries around fixture/migrations/refusal, preparation, copying, seal validation, all 24 paging variants, tools/search, default-size recovery, and negative reads; no clocks or production operations were mocked. The temporary instrumentation was removed before the source change.

The compact case retains 100 rows and 200 KiB metadata per row, a 30-second timeout, all paging variants, streaming cursor guard, real R2 compression/hashing/sealing and default-size recovery. The added assertion explicitly requires multiple raw compact objects.

Normal phases totaled about 2.6 seconds. Coverage with two busy processes on the same two CPU cores took about 5.7 seconds. Eighteen busy processes on two cores reproduced the unchanged 30-second test timeout: copy alone grew from 0.93 to 10.63 seconds. This is a controlled contention experiment, not a claim that CI had exactly eighteen busy processes. CI logs prove Turbo started coverage across 22 packages; Turbo defaults to up to ten concurrent tasks, and each Vitest package creates its own worker pool. The initial serial package experiment preserved each package's file parallelism; the current middle experiment bounds both package and worker counts. Full CI duration must still fit its existing 45-minute limit.

The lifecycle list already sorts by timestamp then ULID. ULID suffixes are random within a millisecond; the test's causal insertion-order assumption was stronger than the listing contract. Both real handoff decisions and the matching handoff detail remain asserted.

## Current validation and gates

Draft PR [#2728](https://github.com/raphaeltm/simple-agent-manager/pull/2728) is open with `needs-human-review`. Serial-package benchmark CI 43597991790 passed at head `5f1927e9c146083635030b60494ab22e6abfeb7a`. The bounded middle option is now selected from the measurements below; coordinator approval is still pending. The coordinator requires real Test-job wall-clock measurements for serial package execution and a bounded middle option, then the fastest stable choice. Historical baselines are 32:00, 24:00, and 20:44; structured results are in `ci-budget-comparison.json`.

Targeted ESLint and formatting, ProjectData typecheck, API/dependency build (12 Turbo tasks), API typecheck, and the full ProjectData package (528 tests in 50 files) passed. Both meaningful mutations failed as intended and production source was restored: removal of the real export byte guard fails the 100-row case; omission of the real handoff decision emission fails the final tied-clock case. `mutations.json` contains exact substitutions and reproduction commands.

Test and Cloudflare specialist reviews passed after the controlled-clock gap was fixed. The completion audit found no additional implementation gaps; real CI comparison is complete; final current-head CI, CodeRabbit and coordinator approval remain pending. Staging is explicitly skipped for this test/config-only PR. CI, trusted CodeRabbit request/wait, final full-SHA coordinator handoff and approval remain outstanding. Do not merge without approval of the exact final head.

## Compact stability completed

All 30 normal and 30 loaded full-file runs passed, 780 tests total, zero failures/skips/retries. Target 100-row case median/max: normal 2649.86/2967.58 ms; loaded 7255.38/10279.54 ms. Both CPU burners consumed positive CPU in every loaded run. `compact-summary.json` summarizes results, with raw per-case timings and source hashes in `repeat-results.jsonl`. Only the compact test source hash is relevant to compact runs; the independent lifecycle test gained a controlled-clock assertion during the last loaded compact batch.

Reviewer gap addressed: lifecycle test now freezes Date only before the actual seed and handoff, then asserts both persisted decision timestamps equal that frozen instant. Full workerd file passed 9/9 and proves the freeze reaches both DO and handoff write contexts. `onTestFinished` restores the clock while real scheduling timers remain real. Repeating the emission omission under this final clock again produced exactly one failure; production source restored. Lifecycle 30+30 repetitions are complete, as summarized below.

Lifecycle stability completed: all 30 normal and 30 loaded full-file runs passed, 540 tests, zero failures/skips/retries. Every run used a fresh real workerd process with the final controlled tied-clock case. Target normal median/max: 18/20 ms; loaded: 39/48 ms. Full-file CLI wall median/max: normal 26.88/27.69 s; loaded 54.73/61.52 s. Both burners consumed positive CPU in every loaded run. `lifecycle-summary.json` contains derived counts and timing summaries. All 120 runs across both files have unique expected indices and matching relevant test-source hashes. Real CI budget comparison is complete.

The coverage step logs `os.availableParallelism()` rather than assuming runner capacity. Installed Vitest derives its default non-watch pool size from available CPUs (normally CPUs minus one, at least one). The middle candidate will bound package and file concurrency using the observed runner size.

## Real CI budget comparison

Serial Test job 132456561421 in run 43597991790 passed on four available CPUs, taking 32:55 wall-clock (13:05:43–13:38:38 UTC); Turbo coverage took 30:41.896 with all 39 tasks successful. API 15,166 tests and ProjectData 528 tests passed. Whole-workflow failure came from the mandatory human-review hold and an initial preflight checkbox fixed in the description. Compared with historical 32:00/24:00/20:44 jobs, serialization is 0:55/8:55/12:11 slower. The required middle comparison is now two package tasks and maxWorkers=75%, explicitly capping each Vitest pool at three workers on the measured four-CPU runner. The next paragraph records the completed comparison and selection.

Middle Test job132465383000/run43600923592 passed25:27 (13:40:39–14:06:06UTC), with23:37.382 coverage and39/39tasks successful on four CPUs. All technical jobs passed; only the mandatory review-hold label fails the specialist gate. API15173passed/4existing-skipped, ProjectData528passed. The first middle run measured7:28 less job time and7:04.514 less coverage time than serial; is1:27 over median historical24:00 and4:43 over fastest20:44. The initial comparison measured one run per budget. Main advanced between merge refs: middle includes PR2727 and seven additional API tests, so these are operational wall-clock measurements with normal runner variation, not a controlled microbenchmark. No timeout or fixture changes.

Subsequent completed middle-budget Test jobs: run43603370455/job132472867639 took23:03; run43609124250/job132490264611 took34:11. Across all three completed middle runs, median25:27 and range23:03–34:11; the latest exceeded serial32:55. The initial7:28 difference is a single-run observation, not a stable saving. The coordinator accepted this median and requested the next three main CI Test durations on idea01M7CTAXZ79SAZCR2DSDMVCF7D, with a flag if their median exceeds about30minutes.

Superseded middle-budget Test attempts were canceled after partial execution and excluded from the median: run43603254119/job13247240327200:42, run43607514504/job13248532544109:40, run43608405473/job13248873741400:42, run43608772457/job13248927982201:01. No test failure or retry occurred in those attempts.

## Recorded full-file procedure and review outcome

The temporary repeat helper was removed from the PR at the coordinator's request. Recorded results and source hashes remain the evidence: repeat-results.jsonl, compact-summary.json and lifecycle-summary.json. For each file, run30 fresh processes normally and30 under CPU load, with unique indices and no retries. Each invocation uses the actual full test file:

- Compact: pnpm --filter @simple-agent-manager/project-data exec vitest run tests/unit/project-data-compact-archive.test.ts --reporter=json --outputFile=<private-report.json>.
- Lifecycle: pnpm --filter @simple-agent-manager/api exec vitest run --config vitest.workers.config.ts tests/workers/node-lifecycle-decisions.test.ts --reporter=json --outputFile=<private-report.json>.

Loaded runs pin the test process to two available CPU cores via taskset, with one real busy Python process pinned to each same core. Measure each burner's CPU time before and after each run; all recorded loaded runs show positive consumption by both. Run in foreground batches of at most10 with a540-second batch deadline and180-second process deadline. Retain full case timings, pass/fail/skip counts and relevant source hashes. Stop every owned process group and load process after the batch, including on interruption. The120 recorded full-file runs total1320 passing cases; no timeout, fixture or test assertion was weakened.

CodeRabbit finding4574159067 led to an inner finally cleanup fix and a real SIGINT red/green probe, retained in interrupt-cleanup.json. Later finding4574568339 identified additional descendant-cleanup limits in the throwaway helper. The helper is now removed rather than shipped as a reusable process tool. Finding4574568334 is addressed by the complete later-run timing disclosure above. CI configuration and both test sources remain byte-identical to a6f8ad869d56857bbc72d096452f9a5a97580ee3. No production source changed.
