# Workers CI duration and flaky tests

SAM task: 01M4DV59SH1MCGWD5D9CZX5RB0. Idea: 01M4DR61XZSCBM4314Y7NY4B0K.

## Research
Main ca040cf72 run 37736428804 job 113224567463: 25m21s job, Vitest 1409.72s (setup 1032.88s, tests/hooks 323.93s), 112 files passed. Migration dominance is a hypothesis: setupDuration measures module import, while beforeAll migration execution belongs to tests/hooks. Measure both before choosing optimization.

## Checklist and acceptance
- [ ] Record baseline setup vs tests/hooks per file; isolate migration cost.
- [ ] Reduce full Workers job below about 15 minutes, retaining isolation, tests, assertions and required checks.
- [ ] Fix repo-selector readiness flake; retain mount fetch, focus and selection assertions.
- [ ] Fix scheduler Mobile Chrome screenshot flake; retain visual/accessibility/overflow coverage.
- [ ] Inspect SDK permission attempt-scoping runtime and fix flake with discriminating guard proof.
- [ ] Fix snapshot operation deadline flake with discriminating deadline proof.
- [ ] Run affected suites and lint/typecheck/build; local specialist review and completion validation.
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
