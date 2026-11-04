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
  (first bound deployment node: 2026-08-26).
- `cleanupDeploymentNode()` → `deleteNodeResourcesStrict()` → `requireStrictNodeProvider()` throws
  "exact provider credential binding is missing" on every attempt, before any provider call.
- PR #2472 (merged 2026-10-29) added `recoverLegacyDeploymentBinding()` (positive provider ownership
  evidence: labels, IP, location, boot window, credential fence), but
  `runDeploymentNodeCleanup()` only runs it for `status = 'running'` nodes. This node was already
  `destroying`, so it never got a binding and could never be deleted.
- The failure went to `nodes.error_message` (cleared on the owner-attested deletion), never to
  `cleanup_blocked_reason` (the claim in `cleanupDeploymentNode()` clears it on every attempt) and
  never to `node_lifecycle_decisions`.
- Production today: zero non-deleted managed VM nodes lack a binding, so no live node is stuck.
  Self-hosted installations upgrading from pre-August builds can still have them.

## Implementation checklist

### Part 1
- [ ] `classifySessionIdleness()`: bound a working turn on a non-terminal task by the work clock.
      When `sessionWorkAnchor(state) + staleTurnMs <= now` and no harness lease is fresh, the turn
      is idle (`reason: 'prompt_turn_stale'`). Optional input; no bound when omitted.
- [ ] New admin setting `sessions.staleTurnNoWorkMinutes` (default 30, 0 disables), resolved
      through the admin settings registry; threaded to every sleep caller of the classifier
      (eligibility, teardown safety gate, fallback, operational status).
- [ ] `resolveVmPromptDeliveryTarget()`: retry `not_ready` while the target session's sleep is
      claimed (`preparing` inside the claim lease, or `stopping`).
- [ ] Docs: configuration reference / admin settings doc for the new setting; comment in
      `session-sleep-required-turn-end.ts` naming the delivery hold.

### Part 2
- [ ] `runDeploymentNodeCleanup()`: run legacy binding recovery for `destroying`/`error` deployment
      nodes too, before the strict-deletion attempt.
- [ ] `cleanupDeploymentNode()`: keep `cleanup_blocked_since` across attempts, write the failure
      reason to `cleanup_blocked_reason`, clear both on success; record a `destroy_failed`
      decision (and `destroyed` on success) in `node_lifecycle_decisions` (deduped).
- [ ] `ops_find_anomalies`: new class `node_destroying_too_long` with an Operations setting
      `operations.opsAnomalyDestroyingHours` (default 6).

## Acceptance criteria

- [ ] A session whose VM keeps reporting the same `prompting` turn with no messages and no harness
      work for longer than the bound is eligible for automatic sleep, through the real ProjectData
      report path. Control: a turn with a fresh message stays awake. Guard proven discriminating.
- [ ] A durable delivery to a session whose sleep is claimed is held (`not_ready`, no VM prompt
      call) through the real delivery runner; after the claim is gone it is delivered. Guard proven
      discriminating; stale `preparing` claim control.
- [ ] A legacy unbound deployment node in `destroying` gets its binding recovered and is deleted by
      the sweep; when deletion fails, the reason lands in `cleanup_blocked_reason` and a
      `destroy_failed` decision row.
- [ ] `ops_find_anomalies` reports a node destroying past the threshold and not one under it.
- [ ] Staging: deploy, verify the anomaly class and settings via the live API, exercise sleep of a
      real VM session, clean up.

## References

- `.claude/rules/53`, `57`, `62`, `67`, `74`; `apps/api/.claude/rules/47`, `56` (providers)
- `tasks/archive/2026-11-03-*` work-clock change (PR #2499); PR #2472 (deployment teardown)
