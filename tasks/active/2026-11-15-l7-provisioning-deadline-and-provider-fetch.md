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

- [x] Shared constants: default 60 s, bounds 5 s - 180 s (max lowered from 300 s after cloudflare-specialist review)
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
- [x] Staging (2026-11-15, T0 06:23:01, freed 06:32:20, deploy run 43683564808): real Hetzner (cx23 fsn1) and GCP (e2-medium europe-west1-b) nodes to heartbeat in one attempt each; setting written/read/restored through the admin API; GCP candidate temporarily enabled and restored; both nodes deleted with strict proof
- [ ] GAP (reported, not closed): forced failure did not materialize on staging. Staging uses Cloudflare Tunnel transport (no DNS step, started create never cut), so the 5 s setting cut nothing; the cut-after-create/adopt path is proven only by the worker test

## Acceptance criteria

- A create slower than the request timeout completes in one attempt at the default.
- With the setting at its minimum, a slow create is cut after the create, recorded, and adopted
  on the next attempt with exactly one provider create.
- No raw provider text reaches `lastError` through the two `NodeAllocationUncertainError`
  wrappers (F16). Other writers of the same class are explicitly kept out: idea
  `01M7ET89S5653S0WV0N1B0MV12`.
- `providerFetch` works on a runtime that refuses `clone()`; status/headers preserved.

## Worst-case arithmetic (rule 81)

R = retry interval 30 s (`NODE_PROVISIONING_RETRY_INTERVAL_MS`), B = attempt budget, T = tunnel
budget (20 s default, tunnel transport only), A = intent max age 15 min, N = 30 attempts.
`alarm()` re-arms every R while an attempt is in flight, so the next attempt starts at the first R
tick after the previous one ends: cycle = R * max(1, ceil(d / R)) for an attempt of duration d.

| B | First failure noticed (hung pre-create or DNS step) | Cycle if every attempt hangs | Attempts before A | Exhaustion reported |
|---|---|---|---|---|
| 5 s (min, = old behaviour) | 5 s (+T) | 30 s | 30 (N) | ~15 min |
| 60 s (default) | 60 s (+T) | 90 s (120 s on tunnel) | 10 (8) | ~15 min, at most ~16.5 min |
| 180 s (max) | 180 s (+T) | 210 s (240 s on tunnel) | 5 (4) | at most ~18.5 min |

- A fast failure (HTTP error, auth, quota) is noticed immediately at every setting; the budget
  only bounds hangs. Each failed attempt is logged at once (`node_provisioning.durable_attempt_failed`).
- The age check runs only between attempts, so exhaustion can be reported up to one cycle after A.
- A started create is not bounded by B (unchanged since #2646): Hetzner 30 s per request, GCP up
  to ~10-13 min (token exchange + firewall ensure + insert + 5 min operation poll). Tracked in
  `tasks/backlog/2026-11-11-durable-provisioning-attempt-ceiling.md`.
- GCP success path before: create ~12 s, DNS cut, next tick at 30 s, recovery + DNS -> running at
  ~35-45 s over 2 attempts. After: ~12-15 s in one attempt.

## I/O (rule 60)

+1 `resolveAdminSetting` per attempt, served by the per-isolate admin settings cache (TTL <= 60 s)
that `vmTunnels.provisioningBudgetMs` already fills: 0 D1 round-trips warm, 1 batched read cold.
Logging adds none; provider-fetch removes a tee branch.

## Review outcomes

- security-auditor: 0 CRITICAL/HIGH. MEDIUM (raw text via other writers) kept out -> idea
  `01M7ET89S5653S0WV0N1B0MV12`. LOWs fixed: provider-code shape tightened to letters/underscore,
  non-logging GCP hint (`gcpApiErrorHint`), transfer headers dropped on re-wrap, stale doc ref.
- cloudflare-specialist: 0 CRITICAL/HIGH. MEDIUM fixed: max 300 s -> 180 s. LOWs fixed: redundant
  try/catch removed, retry-interval wording, GCP log duplication, doc ref.
- test-engineer: no blockers. Fixed: tunnel test margins (per-call timeout 4.5 s), tunnel-budget
  addition test, resolved default asserted, next-attempt time asserted, writer-path bound
  rejection, spies restored, metering mock consulted-counter, extra summary cases.
- task-completion-validator: WARN, 0 CRITICAL/HIGH. M1 handled by keep-out + idea, M2 by this
  section, L1/L2 fixed.
- Extra discrimination: tunnel-budget addition removed -> `adds the tunnel-setup budget...` red;
  `NULL_BODY_STATUSES` removed -> `keeps a null-body status bodiless...` red.

## Final state (2026-11-15 07:55 UTC)

- PR #2749 ready for review, head `8a1c6519a1d01f447e67d15cdcbecf30214a997c`, CI 22 pass / 12 skipping / 0 fail. NOT merged: owner approves.
- CodeRabbit: 1 Minor docs finding (deadline is a cancellation budget, not a whole-attempt bound), fixed in `8a1c6519`, thread resolved; no incremental re-review arrived.
- Staging done and freed (root accepted strict FREE 06:36:42). Forced-failure/setting-effect check remains a reported gap (tunnel transport).
