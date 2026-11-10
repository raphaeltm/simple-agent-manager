# Explicit task resources must not inherit implicit legacy disk

Idea: 01M6YQHA2RTSYQCXZTXSRQJ938. Second PR after #2595 production confirmation.

## Problem and research

Explicit small task CPU/RAM leaves disk absent, and the shared resolver fills it from a profile's legacy medium translation (40GB). The platform fallback also defaults to40GB, so suppressing the legacy contribution alone cannot satisfy acceptance.
`dispatch-tool.ts` collects stored skill/profile/project fields then merges the task layer, preserving absence. `placement-resolver.ts` separately collects legacy sizes and calls the shared `resolveResourceReservation`. This is the policy boundary; fixing dispatch alone would miss submit, run, SAM dispatch, retry and fallback consumers.
Shared direct callers: placement-resolver, workspace-admission-sql, task-runner/node-selection-shared, workspace-steps, placement-diagnostics. Explicit modern lower-layer fields must remain independently inheritable (rule73).

## Plan

- [x] Add discriminating shared resolver and real MCP dispatch persistence tests: explicit CPU/RAM over medium legacy profile, plus omitted/empty requirements legacy control.
- [x] Suppress lower legacy compatibility contributions after higher modern CPU/RAM sizing; preserve same-layer legacy semantics and explicit lower fields, false/zero overrides.
- [x] Resolve platform disk fallback so an unrequested disk does not force a larger offering; preserve configurable override authority.
- [x] Preserve intent/provenance through persisted plan roundtrip; investigate old provenance-only rows.
- [x] Update affected public resource documentation.
- [x] Run shared full suite and API targeted+quality checks; let early draft CI run full suites.
- [x] Complete local specialist/completion reviews.
- [x] Obtain coordinator staging slot; deploy exact head and verify the coordinator-approved omitted-disk reproduction with explicit 0.2 vCPU/0.5 GB RAM. Delete all own resources promptly.
- [x] Request CodeRabbit once and wait, send coordinator exact head/gate summary; stay draft+needs-human-review until explicit PR+SHA approval.
- [x] Merge only approved head, monitor production to success and verify deployed main contains merge before bug3.

## Acceptance

Task explicit CPU/RAM, absent disk over medium profile uses disk no larger than smallest offering needs through real resolver. No explicit fields retains legacy translation. Explicit disk requirements survive; controls show false/zero and configurable defaults work. No main commits; archive notes separate draft PR.

References: rule73 optional-field absence; rule62 real trigger; compute-pools resource guide.

Evidence: coordinator and own full SAM workspace+cache samples≈4.4GB each;15GB default gives≈3x growth margin and fits20GB catalog offerings. No host disk reserve is subtracted today (evaluator+atomic SQL). Telemetry summaries contain IO but not disk space. Legacy-only medium remains40GB. Platform CPU2/RAM4 unchanged; memory+host-reserve limitation is outside this bug.

Local review found historical provenance-only replay promoted compatibility fields to explicit. Reader now reconstructs modern fields separately and recovers legacy size/source from compatibility metadata when missing; stored historical reservation remains unchanged for no-op recovery. Tests cover mixed historical requests, genuinely explicit disk, legacy-only replay and a new task override.

## Final verification and release (2026-11-09)

Completed through [PR #2601](https://github.com/raphaeltm/simple-agent-manager/pull/2601). Approved head `2afc68a0dbb48be9f54249b5364dc74ca60209c3` merged as `dd63a31218f9a5a7877ebbe42b16bd167ec39a0d` after technical CI, specialist reviews, the CodeRabbit request/wait, and exact-head coordinator approval.

Coordinated staging deliberately omitted disk to reproduce this bug, with coordinator authorization. The real resolver selected the 15 GB platform fallback and a small cx23 offering instead of inheriting medium-profile 40 GB disk. Explicit CPU/RAM remained 0.2 vCPU/0.5 GB. The node was explicitly deleted and D1 cleanup verified. Heartbeat and workspace startup were not observed: cleanup followed resource resolution and offering verification. This is evidence of the resolver fix, not a completed workspace lifecycle. Evidence: library `pr2601-staging-evidence.json` and `pr2601-disk-default-evidence.json`.

Production [42590281237](https://github.com/raphaeltm/simple-agent-manager/actions/runs/42590281237) succeeded and the deployed main contained the merge before bug 3 began. Local regression/integration tests cover explicit versus legacy-only requests, zero/false overrides, configurable defaults, historical compatibility provenance and persistence replay. Final task-completion review found these criteria covered; the stale workflow checkboxes above are now reconciled. Archive notes remain a separate draft PR for coordinator review.
