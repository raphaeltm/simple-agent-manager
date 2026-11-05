# Stale "prompting" sleep blocks, cancel-for-sleep re-prompt, and deployment-node teardown

SAM task `01M6KCDGN1Q04CZPMWDT81SME3`. Ideas `01M6K6QTEE7T9KNYB7317D7Y8E` (primary) and
`01M6K6R2255R7414WSER4N3STJ` (secondary). Related: idea `01M5VG7QCDGW77VY1N4QCDJRQK` (hung final
ACP turn), policies d08d64dc, 0f05422d and a3780107.

## Problem

1. A conversation's session refused to sleep for ~10 hours with "Workspace agent is not idle
   (prompting)" while its large VM sat at 0 CPU.
2. When an operator's required sleep cancelled the turn, the restarted agent received two queued
   durable prompts, the sleep aborted ("Workspace activity changed while the final snapshot was
   captured"), and the agent ran an unrequested Opus turn.
3. Deployment node `01KXAR1T3XCQKKPBEJEERQ2PSZ` (Hetzner 150100869) sat in `destroying` from about
   2026-10-24 until it was deleted by hand on 2026-11-04. Nothing recorded why.

## Research findings

### Part 1: what the sleep gate reads, and why it stayed "prompting"

- The refusal string comes from `sessionSleepDeferralReason()` in
  `apps/api/src/services/session-sleep-eligibility.ts`. `checkAutomaticSessionSleepEligibility()`
  reads ProjectData `session_state` through `projectDataService.getSessionState()` and classifies it
  with `classifySessionIdleness()` (`services/session-idleness.ts`).
- **The lost-report hypothesis is false for this incident.** Evidence (platform_errors from the VM,
  session `22810364-dd2a-40dc-82b3-eb0b051e1630`):
  - 00:37:39Z prompt 5 completed (end_turn). The `/messages` 500s at 00:20–00:35Z were message
    persistence, not activity reports.
  - 02:01:07Z prompt 6 started, a control-plane durable delivery (`1ea4176b-…`).
  - 11:55:26Z prompt 6 was cancelled by the operator's sleep. VM-reported duration: **9h54m**.
  - So the store said `prompting` because the VM's own session host was prompting: a hung turn.
    The existing stale-activity probe (`session-activity-reconciliation.ts`) asks the VM's
    SessionHost, which answered "working", so it correctly refreshed rather than reconciled.
- The work clock (`session_state.work_at`, PR #2499) already exists and same-turn re-reports do not
  move it. The completed/failed-task drain in `classifySessionIdleness()` is bounded by it, but a
  **non-terminal** task (this one was a `conversation`, `in_progress`) hits
  `if (activity !== 'idle') return prompt_turn_active` with **no bound at all**. That is the defect.
- The authoritative end-of-turn signals are already wired: the VM's `idle` report, and the probe of
  the live SessionHost for a lost report. The `awaiting_followup` task callback carries no turn
  identity, so ending a turn from it could stomp a new turn the VM started immediately after
  (queued deliveries start as soon as the session reads idle). Not adding it; the no-work bound
  below covers a lost report the probe cannot reach.

### Part 1: why the cancel re-prompted

- A required sleep calls `endAgentTurnForRequiredSleep()` after `claimSessionSnapshotSleep()` has set
  `session_snapshots.sleep_status='preparing'`. The VM cancels the prompt and restarts the agent
  idle (`session_host_process.go`, `intentionalPromptCancel` path). That restart does not increment
  `restartCount` (it is not the crash path) and it is deliberate: if the sleep then fails, the chat
  keeps a working agent (doc comment in `session-sleep-required-turn-end.ts`).
- Prompts 7 (`d2ca6d68-…`) and 8 (`6a7e23ca-…`) were control-plane durable deliveries
  (`viewerId: control-plane`) that had been retry-waiting behind the hung turn. The turn end
  nudged them and `resolveVmPromptDeliveryTarget()` (`services/vm-prompt-delivery-target.ts`) let
  them through, because it does not look at an in-progress sleep. The fix belongs there: a session
  whose sleep is claimed (`preparing` within the claim lease, or `stopping`) is not a delivery
  target. After the sleep the session is `sleeping` and the delivery wakes it through the normal
  recovery path. No VM agent change is needed, so no rollout compatibility concern (rule 54).

### Part 2: why the deployment node could not be deleted

- Production D1: the node row has `placement_credential_source/reference/version/fingerprint` all
  NULL. It was provisioned 2026-07-12, before deployment nodes recorded a credential binding
  (first bound deployment node: 2026-08-26). It went `destroying` around 2026-10-24/25 (its
  environment stopped 2026-10-24T08:06Z; last heartbeat 2026-10-25T03:40Z).
- Before 2026-10-29, `deleteNodeResourcesStrict()` → `requireStrictNodeProvider()` refused every
  unbound node with "exact provider credential binding is missing", before any provider call. That
  is certain for the first ~4 days.
- PR #2472 (merged 2026-10-29) made `deleteNodeResourcesStrict()` call
  `recoverLegacyDeploymentBinding()` for any status (the sweep's own call covers `running` nodes).
  It recovers a binding only from positive provider evidence: one candidate credential, the VM's
  id/IP/location/boot window, and SAM labels. For this node it kept returning `false`, so deletion
  kept failing. **Which predicate refused cannot be reconstructed**: the function returned a bare
  `false`, the failure went only to `nodes.error_message` (cleared by the owner-attested deletion on
  2026-11-04, which also nulled `ip_address`), and the Worker log query tool does not return those
  log fields. Candidates: an IP or boot-window mismatch with the July server, or a label on the
  July server (environment/installation) that differs from today's values.
- Contributing defect: the claim in `cleanupDeploymentNode()` cleared `cleanup_blocked_since` and
  `cleanup_blocked_reason` on every hourly attempt, which erased what the stranded-node sweep
  records and reset its alert clock. No `node_lifecycle_decisions` rows were written by deployment
  teardown at all.
- Production today: zero non-deleted managed VM nodes lack a binding, so no live node is stuck.
  Self-hosted installations upgrading from pre-August builds can still have them.
- Decision: do not loosen strict deletion's ownership proof (a security design change with nothing
  live to fix). Ship the observability so the next refusal names its predicate.

## Implementation checklist

### Part 1
- [x] `classifySessionIdleness()`: bound an open turn on a non-terminal task by the work clock
      (`reason: 'prompt_turn_stale'`). Optional input; no bound when omitted.
- [x] Admin setting `operations.sessionStaleTurnNoWorkMinutes` (default 30, 0 disables), resolved
      lazily (only for a non-idle state) by `checkAutomaticSessionSleepEligibility()` and
      `sleepTeardownSafetyGate()` (now returns an async classifier; execution, teardown and fallback
      callers updated).
- [x] `resolveVmPromptDeliveryTarget()`: retry `not_ready` while the target session's sleep is
      claimed (`preparing` inside the claim lease, or `stopping`), `isSleepClaimHoldingDelivery()`.
- [x] Not done, by decision: ending a turn from the `awaiting_followup` task callback. It carries
      no turn identity, so it could end a newer turn started by a queued delivery; the existing
      probe of the VM's SessionHost already reconciles a lost idle report, and the no-work bound
      covers an unreachable VM.
- [x] Not done, by decision: suppressing the VM's restart after a sleep cancel. It is the
      intentional-cancel path (no restart-count increment) and keeps the chat usable if the sleep
      fails; the harm was the delivered prompt, now held. No VM agent change, so no rollout concern.
- [x] Docs: `guides/admin-settings.md` (Stale agent turns), `architecture/overview.md`, comment in
      `session-sleep-required-turn-end.ts`.

### Part 2
- [x] `cleanupDeploymentNode()`: keep `cleanup_blocked_since` across attempts, write the cause to
      `cleanup_blocked_reason`, record `destroy_failed` / `destroyed` decisions
      (`source: 'deployment_teardown'`); the terminal retire already clears the columns.
- [x] `recoverLegacyDeploymentBinding()`: `attemptLegacyDeploymentBindingRecovery()` names every
      refusal; refusals other than `not_legacy` / `missing_provider_instance` are logged and
      recorded as `legacy_binding_refused` decisions (deduplicated).
- [x] `ops_find_anomalies`: `node_destroying_too_long`, setting
      `operations.opsAnomalyDestroyingNodeHours` (default 6); docs and env-reference updated.
- [x] Removed my first-cut extra recovery call in `cleanupDeploymentNode()`: strict deletion already
      runs it (found when the discrimination check stayed green).

## Acceptance criteria

- [ ] A session whose VM keeps reporting the same `prompting` turn with no messages and no harness
      work for longer than the bound is eligible for automatic sleep, through the real ProjectData
      report path. Control: a turn with a fresh message stays awake. Guard proven discriminating.
- [ ] A durable delivery to a session whose sleep is claimed is held (`not_ready`, no VM prompt
      call) through the real delivery runner; after the claim is gone it is delivered. Guard proven
      discriminating; stale `preparing` claim control.
- [ ] A legacy unbound deployment node in `destroying` gets its binding recovered and is deleted by
      the sweep; when deletion fails, the reason lands in `cleanup_blocked_reason`, the blocked
      clock survives retries, and `destroy_failed` + `legacy_binding_refused` decision rows name the
      cause.
- [ ] `ops_find_anomalies` reports a node destroying past the threshold and not one under it.
- [ ] Staging: deploy, verify the anomaly class and settings via the live API, exercise sleep of a
      real VM session, clean up.

## References

- `.claude/rules/53`, `57`, `62`, `67`, `74`; `apps/api/.claude/rules/47`, `56` (providers)
- `tasks/archive/2026-11-03-*` work-clock change (PR #2499); PR #2472 (deployment teardown)
