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
