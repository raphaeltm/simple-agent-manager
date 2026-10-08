# Workers CI duration and flaky tests

SAM task: 01M4DV59SH1MCGWD5D9CZX5RB0. Idea: 01M4DR61XZSCBM4314Y7NY4B0K.

## Research
Main ca040cf72 run 37736428804 job 113224567463: 25m21s job, Vitest 1409.72s (setup 1032.88s, tests/hooks 323.93s), 112 files passed. Migration dominance is a hypothesis: setupDuration measures module import, while beforeAll migration execution belongs to tests/hooks. Measure both before choosing optimization.

## Checklist and acceptance
- [x] Record baseline setup vs tests/hooks per file; bound migration cost within total tests/hooks.
- [x] Reduce full Workers job below about 15 minutes, retaining isolation, tests, assertions and required checks.
- [x] Fix repo-selector readiness flake; retain mount fetch, focus and selection assertions.
- [x] Fix scheduler Mobile Chrome screenshot flake; retain visual/accessibility/overflow coverage.
- [x] Inspect SDK permission attempt-scoping runtime and fix flake with discriminating guard proof.
- [x] Fix snapshot operation deadline flake with discriminating deadline proof.
- [x] Run affected suites and lint/typecheck/build; local specialist review and completion validation.
- [ ] Record before/after CI timings in PR and ideas; CodeRabbit request/wait, merge, verify faster main CI.
- [ ] Announce shared setup merge; publish MERGED/DONE and cancel subscription.

CI-only changes are explicitly exempt from staging. Runtime changes require coordinated staging.

## Measurements and decisions
- Per-file diagnostic sample: `tasks/evidence/2026-10-08-workers-ci/baseline-sample.csv` (13 files). This is a shared development VM with concurrent tooling; it is not a runner-speed comparison. The unchanged baseline hit a hook timeout in incremental-materialization; the sample was then interrupted (no coverage claim).
- Cloudflare pool 0.17.0 appends an import of `main` to `cloudflare:test` (`dist/pool/index.mjs:2907`), loading the full API graph per isolated file. Vitest setupDuration is setup-module import, while migration beforeAll belongs to tests/hooks. Main setup1032.88s already exceeds ALL tests/hooks323.93s: migration-only optimization cannot meet the goal.
- Three isolated Vitest shards preserve serial file execution and all existing tests/build/migration checks. A fail-closed aggregate keeps the original branch-protection name. Upload incremental per-file timing artifacts for future diagnosis.
- ACP baseline reproduced2/200 under race detector (no data-race warning). SDK notification dispatch lets the first session/cancel arrive after the second Prompt; fake-agent Cancel acknowledgment fixes protocol ordering. Fixed200/200. Removing the host's attempt-ID condition fails the stale-cancel assertion as required.
- Snapshot test now observes the real request context at injected HTTP transport, eliminating TCP/server-arrival scheduling. HTTP client timeout disabled so it cannot mask a missing operation deadline; fixed50/50 under race detector. Deadline/propagation mutations pending.
- Independent review caught hidden timing-artifact directory exclusion; output moved to `test-results/workers-timing.json`.
- Snapshot review widened the test operation deadline to 1s for admission/persistence headroom while retaining the inherited-deadline check, cancellation, and 5s watchdog. Both deadline removal and context detachment mutations fail. Repeat final test pending.
- SDK peer ordering is tracked separately in Idea `01M4DWVB4749F6GPJY0E9QVAX7`: no actual supported-runtime incident established, but production admission does not acknowledge peer cancel consumption. This PR isolates the waiter-fence test, and does not claim all peer races fixed.
- Final snapshot variant: 20/20 race repetitions passed; both operation-deadline and request-context-detachment mutations fail at inherited deadline and HTTP failure assertions. Runtime restored.
- Repo-selector old focus-before-response ordering deterministically fails the existing dropdown assertion; final test restored.
- Screenshot error-classification guard mutation fails the closed-page no-retry assertion; helper restored. New helper unit tests3/3 and CI gate tests12/12 pass.
- Root typecheck19/19 and build9/9 pass. Lint found only reporter import order (fixed; targeted lint passes); remaining packages passed with existing warnings. Full unit suite is running with two Vitest workers/one package at a time.
- Unchanged incremental-materialization suite rerun passed21/21, also exercising the new reporter. Its shared-VM timing is not used as CI speed evidence.

- Browser repetitions:29/30 passed; first desktop navigation hit404 because our overlapping build cleared dist. Screenshots reviewed on desktop/mobile (blog index and scheduler lab): no clipping/overflow/readability issues. Clean30-case repeat started after builds and mutation experiments ended.

- Clean scheduler verification:30/30 browser cases passed (three repeats of five tests on desktop and Mobile Chrome), including screenshots, accessibility, overflow and32-task stress. Final source restored after all mutations.

## First CI comparison
Baseline25m21s → branch run37788609053 critical path10m46s (first shard13:58:34Z → aggregate14:09:20Z),58% faster. Shards10m06s/5m33s/6m17s all pass. Artifact union112 distinct files38+37+37 exactly equals suite; logs436+545+410=1,391 passing tests, identical to baseline. Full per-file after CSV committed alongside baseline sample. Single pre-merge run, not a new median. Main verification pending.

Full branch workflow 37788609053 PASS, including root Test, Lint, Type Check, Build, full Go race suite, Marketing Site, and all Workers shards/gate. Local redundant bounded root unit run continues; no failures observed. Active task retained until merge and main verification, per completion review.
