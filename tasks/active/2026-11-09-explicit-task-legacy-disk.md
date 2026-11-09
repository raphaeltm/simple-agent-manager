# Explicit task resources must not inherit implicit legacy disk

Idea: 01M6YQHA2RTSYQCXZTXSRQJ938. Second PR after #2595 production confirmation.

## Problem and research
Explicit small task CPU/RAM leaves disk absent, and the shared resolver fills it from a profile's legacy medium translation (40GB). The platform fallback also defaults to40GB, so suppressing the legacy contribution alone cannot satisfy acceptance.
`dispatch-tool.ts` collects stored skill/profile/project fields then merges the task layer, preserving absence. `placement-resolver.ts` separately collects legacy sizes and calls the shared `resolveResourceReservation`. This is the policy boundary; fixing dispatch alone would miss submit, run, SAM dispatch, retry and fallback consumers.
Shared direct callers: placement-resolver, workspace-admission-sql, task-runner/node-selection-shared, workspace-steps, placement-diagnostics. Explicit modern lower-layer fields must remain independently inheritable (rule73).

## Plan
- [ ] Add discriminating shared resolver and real MCP dispatch persistence tests: explicit CPU/RAM over medium legacy profile, plus omitted/empty requirements legacy control.
- [ ] Suppress lower legacy compatibility contributions after higher modern CPU/RAM sizing; preserve same-layer legacy semantics and explicit lower fields, false/zero overrides.
- [ ] Resolve platform disk fallback so an unrequested disk does not force a larger offering; preserve configurable override authority.
- [ ] Preserve intent/provenance through persisted plan roundtrip; investigate old provenance-only rows.
- [ ] Update affected public resource documentation.
- [ ] Run shared full suite and API targeted+quality checks; let early draft CI run full suites.
- [ ] Complete local specialist/completion reviews.
- [ ] Ask coordinator for staging slot; deploy exact head and verify real resolver via browser/API with explicit .2/.5/5 staging test resources. Delete all own resources promptly.
- [ ] Request CodeRabbit once and wait, send coordinator exact head/gate summary; stay draft+needs-human-review until explicit PR+SHA approval.
- [ ] Merge only approved head, monitor production to success and verify deployed main contains merge before bug3.

## Acceptance
Task explicit CPU/RAM, absent disk over medium profile uses disk no larger than smallest offering needs through real resolver. No explicit fields retains legacy translation. Explicit disk requirements survive; controls show false/zero and configurable defaults work. No main commits; archive notes separate draft PR.

References: rule73 optional-field absence; rule62 real trigger; compute-pools resource guide.
