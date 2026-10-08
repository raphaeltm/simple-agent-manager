# Measure and reduce session start/wake latency

## Problem

Warm user starts measured p50 82s/p90 185s; reused-node wakes 159s/219s. Workspace setup is largely unmeasured. Build deferral can delay user conversation starts up to 20 minutes. Source ideas: 01M27MAVRGWCFZ8FCEBGVQ00BA, 01M0VZ205TN8A1JYHNJN77DS4F, 01M0FV9VBP8ZATBG2E63R8GD0M.

## Research

- VM provision.Run emits fixed provision.* step durations to local eventstore; node ready callback can carry an allowlisted bounded summary.
- TaskRunner advanceToStep has lastStepAt for wall-clock phases including polling; error handler measures only a single alarm invocation.
- Snapshot progress callbacks are throttled and currently discard step; capture completion can carry bounded phase summaries.
- Instant already logs cold_start_complete timings; add corresponding start marker.
- Build queue veto exists in advisory workspace-resource-capacity AND final workspace-placement SQL. Exemption must reach both while retaining aggregate reservations and all safety predicates.

## Checklist

- [x] Bounded, allowlisted VM provision and workspace setup timings reach control plane.
- [x] Wake/start and sleep phase durations cover success and failure; Instant start marker.
- [x] User-initiated conversation starts bypass build queue only; background tasks remain deferred.
- [x] Tests for bounded/safe telemetry, compatibility, user/background discrimination and atomic capacity race.
- [x] Documentation and local specialist review.
- [x] Lease staging; fresh VM binary, heartbeat/access, start/sleep/wake checks; delete VMs and release.
- [ ] PR/CI/CodeRabbit, merge, production deploy and first phase measurements.
- [ ] Append evidence and next-cut proposal to ideas; complete only fully shipped scope.

## Acceptance criteria

No per-sample central DB writes, no raw telemetry in ProjectData, no per-node workspace caps. Final reservation retains resource safety under concurrency. Old callbacks remain compatible. Real staging VM verifies new agent. Post-deploy report identifies largest remaining measured phase without implementing next optimization.

## References

VM rules 27/54/78; API rule 69; telemetry policy 235ad923; scheduling policy 95c3329a. Coordination reliability-wave-1008 kickoff staging lease and migration claims.

## Recovery validation

- Original implementation preserved after runtime loss; resumed from transcript and saved state.
- Fixed bootstrap cache span boundaries, dropped four unsupported labels, and mapped sam_env to platform_environment only at logging boundary.
- Selector32, real D1 races15, focused callback/admission/capacity90 tests pass. Fresh independent API/security/constitution/docs and Go reviews pass.
- Full quality passed35/35; root tests passed21/21 (API11,647/web4,023); full Go server passed35.7s after correcting the callback fixture, isolated regression3xPASS. These checks preceded staging; the later validation below supersedes that checkpoint.

## Staging validation (2026-10-08)

- Candidate `4429d66a4`, deployment `37835747075`: deployment and smoke job passed; nine local Playwright checks passed.
- Two sequential cx23/fsn1 VMs reported agent `068dede59` (build 15:48:35), with real heartbeats and authenticated system/container access.
- One task/session preserved its identity through start, explicit sleep and snapshot restoration onto the replacement VM. Browser-visible replies were exactly `LATENCY_START_OK` and `LATENCY_WAKE_OK`; canonical activity was idle with zero runtime work afterward.
- Provision, workspace, sleep and wake summaries reached control-plane logs, including the unredacted `platform_environment` label. First measurements and their limitations are in `docs/notes/session-lifecycle-timings.md`.
- The run exposed a five-minute predecessor-deletion fence. Test attachment cleanup also marked the user pool migration pending; reconciliation changed authority and required replacement of the first node. These confound elapsed wake time and are not a production latency baseline. The existing composable credential-anchor issue was reproduced and appended to idea `01M3D3P0A05ED6EKM1K2QGF1FH`.
- Both VMs, both workspaces, the snapshot and owned setup resources were deleted with API confirmation and empty D1 results. The borrowed project/profile were retained; original pool policy and all 139 candidate settings were restored and compared successfully.
- Lease released at 20:47 UTC (channel sequence 111); next queued task received a durable direct handoff. No staging resources remain held.
- Task-completion review: premerge PASS with no implementation findings. Production deployment, production samples and final idea reports remain pending; do not archive before those finish.
