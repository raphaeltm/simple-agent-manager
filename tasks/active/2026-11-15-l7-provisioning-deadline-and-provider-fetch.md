# L7: per-attempt provisioning deadline and provider-fetch single read

SAM task `01M7EQP5MH0GBMVHA6M7N1JHHG`; landing plan idea `01M72M9AEB933ZY8269D376DKC` (part 5 row L7,
part 2 items C1 and C19, part 4 finding F16). Integration branch `sam/selfhost-pass-2`
(commits 7a9bf8834, 7d1d3712c, 29518e445, ec63658d6, 90c2e6fb7). Behaviour change: the owner
approves the merge. Do not merge.

## Problem

1. A durable node-provisioning attempt (`NodeLifecycleProvisioning.run()`) is bounded by the 5 s
   per-request timeout. A GCP create takes 9-12 s, so every GCP attempt reaches the node DNS step
   on an aborted signal and waits a 30 s retry interval to be adopted (C1).
2. `completeAbortableResponse()` tees the body with `Response.clone()`, which some Workers
   runtimes refuse on an unconsumed stream (C19).
3. A failed attempt's cause is only visible after exhaustion (`lastError` is overwritten), and
   the wrapped provider error is dropped (attempt logging).
4. F16: `NodeAllocationUncertainError` embeds the raw provider error text, which reaches
   `nodes.error_message` and `workspaces.error_message` through `reportExhausted()`.

## Owner decision

Default 60 s (not 45 s), configurable as an admin setting (Raphaël, 2026-11-14).

## Research findings

- Main (#2646) already exempts a started durable create/recovery and its D1 publish from the
  attempt deadline (`provisionNode`, `createContext`, `publishContext`). The deadline cuts the
  pre-create steps (through `ProviderRequestContext`) and the public-IP DNS create. Cutting the
  create stranded VMs on GCP; not changed here.
- Slow create past the deadline: VM identity is recorded (`providerInstanceId`, status
  `creating`), DNS step throws the abort reason, `lastError` = deadline elapsed, the next attempt
  (30 s) adopts by labels (`recoverNodeAllocation`) and publishes `running`. No second create.
- `node-lifecycle-provisioning.ts` is at the 500-line ceiling: helpers go in a new module.
- Admin setting defaults live in `packages/shared` (`node-pooling.ts`), importing from the DO
  module into the settings registry would be circular.
- provider-fetch callers: provider adapters, `fetchGcpWithTimeout`, `dns-core.ts`,
  `dns-node-backend.ts`. None reads `url`, `redirected`, `type`.
- Related backlog, out of scope: `tasks/backlog/2026-11-11-durable-provisioning-attempt-ceiling.md`
  (no overall ceiling on a started create; `inFlight` ignores max age). Ideas
  `01M7EB64WBBRSZJJ0M08M8APNM`, `01M7EB88QA1P81MFT9T389BZFB` out of scope.
- Overlap: draft #2693 touches the same admin settings files (different lines); owner notified.

## Checklist

- [x] Shared constants: default 60 s, bounds 5 s - 300 s
- [x] Admin setting `operations.nodeProvisioningAttemptDeadlineMs` (registry + union)
- [x] `attemptDeadlineMs()` used by `run()`; never below the request timeout
- [x] Per-attempt log `node_provisioning.durable_attempt_failed` with safe fields + cause
- [x] `NodeAllocationUncertainError` keeps `{ cause }`; messages use a safe summary (F16)
- [x] provider-fetch reads once and re-wraps (204/205/304 null body)
- [x] Docs: admin-settings guide, configuration reference, env reference, .env.example
- [x] Tests: provider-fetch (uncloneable stream, null-body status)
- [x] Tests: safe summary/describe unit tests (F16), built through the real `providerFetch` producer
- [x] Tests: worker vertical slice, slow create completes under default; control at 5 s cut then adopted, one create; admin setting effective; attempt log; lastError has no raw provider text
- [x] Discrimination checks recorded:
  - provider-fetch reverted to `clone()` -> `returns a readable body on a runtime that cannot clone...` red
  - attempt budget reverted to the request timeout -> `completes a create slower than the request timeout in its first attempt at the default` red
  - admin setting ignored (always default) -> `at the setting minimum, cuts the attempt after the create...` red
  - F16 reverted (raw message in wrapper) -> `logs each failed attempt ... keeps raw provider text out of lastError` red
  - attempt log removed -> both log-asserting worker tests red
- [x] Existing tests updated: tunnel-transport deadline test re-timed to the 5 s minimum; metering deadline cases pin a 200 ms budget through a passthrough settings mock; two node-tunnel-hardening tests now assert the safe wrapper message plus `cause`
- [ ] Staging: real Hetzner + GCP node to heartbeat, one forced failure, admin setting takes effect, cleanup

## Acceptance criteria

- A create slower than the request timeout completes in one attempt at the default.
- With the setting at its minimum, a slow create is cut after the create, recorded, and adopted
  on the next attempt with exactly one provider create.
- No raw provider message reaches `lastError` / user-visible error columns.
- `providerFetch` works on a runtime that refuses `clone()`; status/headers preserved.
