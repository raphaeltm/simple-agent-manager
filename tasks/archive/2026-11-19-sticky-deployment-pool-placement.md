# Keep deployment nodes across compute pool priority changes

## Problem and preflight
Business logic / cross-component change. A release recomputes the top pool candidate; SQL filters the linked node by that provider before the scheduler can test any eligible candidate. The reconstructed placement also keeps the top provider and credential attribution. Volume preparation ignores existing volume affinity.

Trace: release submission -> resolveDeploymentPlacement / canonical allocation -> placeReleaseOnDeploymentNode -> findDeploymentNodeWithCapacity -> resolveReusableNodeCapacitySnapshot -> linkEnvironmentToNode (atomic capacity and authority check). No API contract or schema changes planned. Stop/start is out of scope.

## Implementation checklist
- [x] Real SQLite tests through release placement: cross-provider reorder stays, removed candidate rejected, capacity and credential controls.
- [x] Only linked-node reuse may cross the selected provider; fresh node admission remains constrained.
- [x] Reconstruct placement from actual node candidate including credentials and use it for volume attachment authority.
- [x] Resolve volume placement using existing provider/location, with accurate rejection when unavailable.
- [x] Update deployment documentation.
- [x] Validate lint/typecheck/tests/build, specialists and completion review.
- [ ] Staging verification, CI and CodeRabbit; merge and monitor production.

## Acceptance
An eligible healthy linked node with capacity stays linked across provider reorder, with its actual placement and credential identity. Removed candidates are refused. Fresh selection remains constrained. Volumes do not move provider/location because priorities changed.

## References
Rules 28, 62, 69, 74. Existing native-placement SQLite tests and scheduler pool capacity reuse are the canonical policies. Prior attempt ignored; fresh origin/main 6e1c998e5.

## Validation evidence
- Pre-fix SQLite divergence: both shared/exclusive retention tests failed; after fix both pass.
- Focused suites: 133/134 passed before updating one expected error string; final focused rerun 31/31 passed. Remaining suites were green in prior run.
- Root build: 19/19 tasks passed. Root lint 23/23 tasks passed; typecheck 38/38 passed. Full API run: 17,829 passed, 2 failed, 5 skipped; both failures were the Compose volume mock missing the newly used list read. Fixed mock and reran Compose 8/8 green. Focused deployment suites 134/134 green. All other package suites passed.
- Completion reviewer PASS for implementation; Cloudflare/constitution/doc/security review PASS.
- Draft PR #2903; staging reservation succeeded, deployment run 44484341664 in progress; live first release applied on Hetzner cx23 at fsn1, heartbeat confirmed. Second release tests GCP-first reorder. Runtime source tree unchanged since staging commit 428873ac8; later commits only task/test changes.

## Workflow status at implementation archive
Implementation and completion review passed. Remaining staging cleanup, CI, CodeRabbit and production gates are tracked in PR #2903 and local .do-state.md; this archive does not claim those operational gates have passed.

### Automated review follow-up

- Fixed stored-volume affinity when the new manifest omits volumes: submission always reads existing environment volume rows before resolving placement. Manifest declarations still control creating missing volumes.
- Added a real SQLite submission regression with stored Hetzner/nbg1 data and an empty volume manifest. Confirmed it fails before the fix because provider/location overrides are absent, then passes after the fix (5/5 affinity tests).
- Incremental completion reviewer: PASS; the extra read is environment-scoped and reuses the existing lookup.

- Completed omitted-volume exclusivity propagation: stored rows now determine effective requiresVolumes before computing the reservation; admission, persistence and volume attachment retain exclusive mode. Manifest declarations alone control creating missing volumes.
- Added active exclusive-node real SQLite submission coverage asserting retained node, persisted exclusive reservation/volume requirement, attachment and no teardown/provision. Disabling the stored-row condition made exactly this new test fail (nodeId null); restored fix passes. API typecheck passed.

### Specific admission refusal reporting

- Addressed automated review4626349099: exclusive release errors now distinguish pool ineligibility, capacity refusal, unavailable node, and final reservation authority changes. Diagnostic classification reuses the scheduler eligibility predicate without the reservation only after its capacity-aware check refuses; admission decisions remain unchanged.
- Added real SQLite release-path assertions for removed provider, exhausted capacity and credential revocation/final reservation refusal. 77 targeted tests PASS, incremental completion review PASS. Extracted existing-node reservation into a route helper to keep placement below800lines.
