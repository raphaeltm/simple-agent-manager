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
- [ ] Validate lint/typecheck/tests/build, specialists and completion review.
- [ ] Staging verification, CI and CodeRabbit; merge and monitor production.

## Acceptance
An eligible healthy linked node with capacity stays linked across provider reorder, with its actual placement and credential identity. Removed candidates are refused. Fresh selection remains constrained. Volumes do not move provider/location because priorities changed.

## References
Rules 28, 62, 69, 74. Existing native-placement SQLite tests and scheduler pool capacity reuse are the canonical policies. Prior attempt ignored; fresh origin/main 6e1c998e5.

## Validation evidence
- Pre-fix SQLite divergence: both shared/exclusive retention tests failed; after fix both pass.
- Focused suites: 133/134 passed before updating one expected error string; final focused rerun 31/31 passed. Remaining suites were green in prior run.
- Root build: 19/19 tasks passed. Root lint import order fixed; rerun in progress. Full typecheck/test in progress.
- Completion reviewer PASS for implementation; domain review PASS, follow-up Cloudflare review running.
- Draft PR #2903; staging reservation succeeded, deployment run 44484341664 queued.
