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
- [ ] Bounded, allowlisted VM provision and workspace setup timings reach control plane.
- [ ] Wake/start and sleep phase durations cover success and failure; Instant start marker.
- [ ] User-initiated conversation starts bypass build queue only; background tasks remain deferred.
- [ ] Tests for bounded/safe telemetry, compatibility, user/background discrimination and atomic capacity race.
- [ ] Documentation and local specialist review.
- [ ] Lease staging; fresh VM binary, heartbeat/access, start/sleep/wake checks; delete VMs and release.
- [ ] PR/CI/CodeRabbit, merge, production deploy and first phase measurements.
- [ ] Append evidence and next-cut proposal to ideas; complete only fully shipped scope.

## Acceptance criteria
No per-sample central DB writes, no raw telemetry in ProjectData, no per-node workspace caps. Final reservation retains resource safety under concurrency. Old callbacks remain compatible. Real staging VM verifies new agent. Post-deploy report identifies largest remaining measured phase without implementing next optimization.

## References
VM rules 27/54/78; API rule 69; telemetry policy 235ad923; scheduling policy 95c3329a. Coordination reliability-wave-1008 kickoff staging lease and migration claims.
