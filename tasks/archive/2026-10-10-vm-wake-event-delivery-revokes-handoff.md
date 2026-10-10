# VM wake fails at handoff: the wake's own event delivery revokes its authority

SAM task: 01M4JRRD41T0X1TER0C56VWAW0 (coordinator 01M4JK3X7BART9SDKJ3KGCDE0Q, channel
`reliability-wave-1010`). Evidence idea: 01M4JMYRY5909JYND1XRXMM9DC. Branch:
`sam/fix-vm-wake-regression-6vwaw0`.

## Problem

Since 2026-10-09, 4 of 26 VM wakes failed at the `agent_session` handoff with "Session
recovery authority was revoked" (0 of 85 in the four days before). The new agent had
already loaded the conversation and started the queued wake prompt. Each failure stopped
that runtime mid-prompt, returned the chat to sleep, and left the new workspace in
operator deletion quarantine.

## Root cause (proven)

**Production evidence (read-only, `CF_PRODUCTION_DEBUGGING_TOKEN`, 2026-10-10):**

| Task                         | Failure     | Delivery                           | Accepted     | `step_error` |
| ---------------------------- | ----------- | ---------------------------------- | ------------ | ------------ |
| `01M4GED49YASA7D7QFG7AW3XA0` | 10-09 15:45 | `1bbc0690…` (CI-subscription chat) | 15:45:04.689 | 15:45:05.823 |
| `01M4FXMYCFTNMT3JTV41HVW14R` | 10-09 18:19 | `141b67f6…` agent-DM batch         | ~18:19:01.36 | 18:19:02.030 |
| `01M4ABRWV97F54MQ1FFJFGHMBA` | 10-09 00:24 | `904f6fd9…` agent-DM batch         | ~00:24:32.35 | 00:24:33.111 |
| `01M4GED49YASA7D7QFG7AW3XA0` | 10-10 00:49 | `782204e8…` (same CI chat)         | ~00:49:49.65 | 00:49:50.710 |

- All four were **project-event wakes** (`source_kind = 'project_event_wake'`). Two
  wake prompts read "SAM notice … agent message batch <deliveryId> … call
  ack_event_delivery with deliveryId <deliveryId>" (agent DMs travel through event
  channels since #2213, 2026-10-07). The other two are in an EffProp chat that is fed by
  GitHub CI webhooks (`github.webhook.project_events_admitted`).
- The delivery for `1bbc0690…` first ran at 15:36:47 (24 s after the chat slept) and
  retried `not_ready` at saturated backoff until a retry at 15:45:01.830 found the new
  runtime and was accepted 2.86 s later, 16 ms after the VM logged "Agent ready".
- `alarm()` only logs `task_runner_do.step_error` when `isCurrentRecoveryAttempt` is
  still true after the throw (`task-runner/index.ts`), and `returnFailedWakeToSleep`
  then succeeded. So the snapshot claim was intact; the failing check was stricter.

**Mechanism (code):**

1. `startSamAwareAgentSession` marks the replacement agent session `running` as its
   first step (`ensureAgentSessionRow`), before the VM session even exists.
2. `resolveVmPromptDeliveryTarget` returns `ready` as soon as the new workspace, node,
   and agent session read `running`. It never asks whether the wake has committed. Its
   designed release is the committed handoff's wake-ready signal
   (`transitionToInProgress` → `notifyWakeSettled` → `signalSessionWakeReady`, checked by
   `isSessionWakeReadyCurrent`), but a backoff retry can arrive first.
3. Acceptance runs `advanceProjectEventPromptAttemptCheckpoint` →
   `updatePromptQueueBatchForAttempt`, flipping the event batch from `pending` to
   `delivered`.
4. The TaskRunner re-checks authority before committing (`agent-session-step.ts`
   `rc.assertRecoveryAuthority`: a per-phase `beforeExternalMutation` guard during the agent
   bootstrap, then three recovery-commit checks). For an event wake this
   calls `validateProjectEventWakeRecoveryAuthority`, which requires a `pending` batch.
   The wake's own successful delivery therefore reads as revocation →
   `SessionRecoveryAuthorityRevokedError` → `failTask` → `returnFailedWakeToSleep` →
   workspace stopped ("SessionHost stopped") and the accepted prompt's turn is killed.
   The batch stays `delivered`, so the event is not redelivered.

The window is from VM SessionHost registration to the handoff check, about 20–25 s in
the traces. Saturated `not_ready` retries run about every 80 s, which matches the
observed rate. Unguarded wakes (human follow-ups) have no event check, so they never
failed this way, but their prompt could still enter a runtime whose handoff later fails.

**Second consumer, found in review.** The woken agent can consume the batch itself. A
degraded snapshot restore starts a fresh session with the recovery prompt before the commit
(`agent-session-bootstrap.ts`), and the woken agent may read its subscription in that turn
(`list_subscription_events` / `get_event` → `markBatchObservedForPull`, which flips a
`pending` batch to `delivered` while its wake row is `retry_wait`) or ack it
(`ackProjectEventDelivery`). No production failure traces to this path, but it produces the
same self-revocation and no delivery hold can cover it.

Writers the evidence idea suspected but which are **ruled out**:
`session-snapshot-prepare.ts` clears `recovery_task_id`, and `markSessionSnapshotSleeping`
clears `recovery_attempt_id` and `recovery_status`. Either would have broken the
task-plus-attempt match, which would have made the catch-time `isCurrentRecoveryAttempt` false
and suppressed `step_error`, and `returnFailedWakeToSleep` would have refused.
`restore-result` writes only `restore_status`.

## Fix design

1. **Hold durable delivery until the VM wake commits its handoff.**
   `resolveVmPromptDeliveryTarget` returns `retry` (`not_ready`) while the target VM
   workspace belongs to an in-flight TaskRunner wake: snapshot claim `waking`, or
   `restored` for this workspace, and the claiming task still `queued`/`delegated`.
   - The existing release path delivers right after commit: `signalSessionWakeReady` →
     `nudgePromptDeliveriesForTarget` and the `wake_ready_attempt_id` latch for a claim
     still preparing.
   - Folded into the existing target query, so no extra round trip.
   - Scoped to `nodes.runtime = 'vm'`. Instant wakes in place, and
     `markSessionSnapshotAwakeInPlace` writes `restored` on every delivery attempt.
   - TaskRunner authority checks are unchanged, so stale-attempt and terminal-source
     protection keep their exact semantics.
2. **Accept the woken chat consuming its own batch.** The TaskRunner's event re-check
   passes `acceptConsumedByTarget`, so `validateProjectEventWakeRecoveryAuthority` accepts
   `delivered` and `acked` as well as `pending`. Only the woken chat can consume the batch
   (pull and ack visibility is bound to the subscription's target), so that is the wake
   succeeding. Cancellation, expiry, subscription and audience changes still revoke. The
   Instant container's per-request guard stays strict: it rides the delivery request
   itself, whose inbox row is `delivering`, so a pull cannot consume the batch first.
3. **Make every `SessionRecoveryAuthorityRevokedError` diagnosable.** The error carries
   a `check` discriminator, and every throw site logs `session_recovery.authority_revoked`
   with:
   - the check, the site, and the task, project, chat, and attempt IDs;
   - a best-effort read of the snapshot row: `recovery_task_id`, `recovery_attempt_id`,
     `recovery_status`, `capture_generation`, `sleep_status`.

   The diagnostic read never masks the original error and carries no secrets.
   `task_runner_do.step_error` also carries the check.

## Every path that submits a prompt to a VM runtime (rule 61)

Three things consume an event batch: durable delivery of the wake prompt
(`advanceProjectEventPromptAttemptCheckpoint` → `updatePromptQueueBatchForAttempt`), the
woken agent reading its subscription (`markBatchObservedForPull`), and its ack
(`ackProjectEventDelivery`). Durable delivery is held until the commit; the runner's
re-check accepts the other two (fix item 2). Read and ack are bound to the subscription's
target chat (`visibleSubscriptionPredicate`), so no other caller can consume the batch. The
direct senders below call `sendPromptToAgentOnNode` themselves and skip
`resolveVmPromptDeliveryTarget`; none of them consumes an event batch.

| Path                                                                                                                                                                                                                                   | Held? | Why                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Durable delivery (`DefaultVmPromptDeliveryAdapter` → `resolveVmPromptDeliveryTarget`): follow-ups (`send-chat.ts`), `send_durable_message`, `send_message_to_subtask` (`orchestration-comms.ts`), parent wakes, event wakes, schedules | Yes   | The production failure path.                                                                                                                                                                                                                                                                                                                                                                       |
| Reconciliation check-in (`project-data/reconciliation.ts` `sendCheckinToAgent`, passes `resolvedTarget`)                                                                                                                               | No    | Only `task_mode = 'task'` tasks, with the chat `active` and idle for `TASK_RECONCILIATION_IDLE_MS` (default 5 min) (`reconciliation-candidates.ts`). A wake makes the chat active (`wakeSessionForSnapshotRecovery`) in the same alarm turn that commits the handoff, so this needs a handoff stalled for 5 minutes. It sends `agent_mailbox`, never an event batch, so it cannot revoke the wake. |
| `stop_subtask` warning (`routes/mcp/orchestration-stop.ts`)                                                                                                                                                                            | No    | The warning precedes stopping the child, and the stop revokes the wake by design.                                                                                                                                                                                                                                                                                                                  |
| SAM `send_message_to_subtask` (`sam-session/tools/send-message-to-subtask.ts`)                                                                                                                                                         | No    | Refuses `delegated` tasks, and a wake's replacement agent session only starts after the workspace step delegates the task, so it cannot reach an uncommitted wake runtime.                                                                                                                                                                                                                         |
| Legacy direct sends with `DURABLE_PROMPT_DELIVERY_ENABLED=false` (`send-chat.ts` `forwardPromptToLiveAgent`, `orchestration-comms.ts`, `mailbox-target.ts` `attemptImmediateDelivery`)                                                 | No    | In that configuration durable delivery and agent channels are off (`durability-foundation.ts`, `agent-message-channels.ts`), so no event batch is delivered. Legacy behavior, unchanged.                                                                                                                                                                                                           |
| Instant / cf-container                                                                                                                                                                                                                 | No    | No TaskRunner handoff; wakes in place (`node_runtime !== 'vm'`).                                                                                                                                                                                                                                                                                                                                   |

## Checklist

- [x] Root cause proven from production logs plus code; candidate writers ruled out
- [x] Split TaskRunner recovery-authority methods out of `task-runner/index.ts`
      (789 lines; rule 18) in its own commit before behavior changes ("refactor(api):
      extract TaskRunner recovery authority checks"); also moved the handoff-restore
      functions out of `session-recovery-authority.ts` (508 lines) into
      `session-recovery-handoff.ts` ("refactor(api): move session recovery handoff restore
      into its own module")
- [x] Gate in `services/vm-prompt-delivery-target.ts` with a comment naming the
      resumer predicate it mirrors (`isSessionWakeReadyCurrent`, `transitionToInProgress`)
- [x] `SessionRecoveryAuthorityCheck` + `check` on the error; logging helper with
      snapshot-row diagnostics in `services/session-recovery-authority-revocation.ts`
      (new module, re-exported, so the 508-line module did not grow)
- [x] The TaskRunner's event re-check accepts its own chat consuming the batch
      (`acceptConsumedByTarget`); the Instant guard stays strict (review finding)
- [x] Every throw site names its check and logs: TaskRunner `assertRecoveryAuthority`,
      `advanceToStep`, `updateD1ExecutionStep` (×2), `putTaskRunnerState`,
      attempt-storage `setAlarm`, warm-node claim (`node-selection.ts`), Instant
      container source guard (`vm-agent-container.ts`)
- [x] `task_runner_do.step_error` includes the authority check
- [x] Workers vertical slice (new file): real agent-DM event wake → real snapshot claim
      and TaskRunner reactivation → real `agent_session` alarm with the VM restore
      call held → real delivery claim mid-handoff → release. Assert the handoff
      commits, the runtime is not stopped, and the prompt is accepted exactly once after
      the wake-ready signal
- [x] Controls: superseded attempt still aborts; terminal (cancelled) task still
      aborts; genuinely revoked event authority (subscription cancelled) still aborts
      with check `project_event_wake_authority` logged
- [x] Gate predicate table against real D1: waking+delegated holds; restored+delegated
      on this workspace holds; restored+in_progress ready; stale restored on another
      workspace ready; Instant (`cf-container`) restored+queued not held; terminal or
      sleeping task not held
- [x] Diagnostics unit tests: each check logged with snapshot fields; diagnostic read
      failure does not mask the error; no secret-bearing fields
- [x] Revert the gate once and record which test goes red (PR body)
- [x] Rule 61 enumeration of every path that submits a prompt to a VM runtime (below,
      and in the PR)
- [x] Docs: architecture overview (prompt-delivery paragraph) and chat features
      ("Sleeping") describe the handoff hold
- [x] Lint, typecheck, focused and full API tests (sequential), build (full unit suite
      11,962 tests; full Workers suite exceeds a local run, so a focused 22-file run passed
      174/174 and CI runs all shards)
- [x] Local specialist reviews + task-completion-validator (all PASS or ADDRESSED; see PR)
- [ ] Staging: one real VM wake via a queued event or DM (STAGING_CLAIM/RELEASE, clean up)
- [ ] PR, CI, CodeRabbit request and wait, SonarCloud, merge, production deploy and
      release check

## Test evidence

- `tests/workers/vm-wake-event-delivery-handoff.test.ts`, 4 tests. Real agent-DM wake,
  real `ensureSessionRecovery` claim and TaskRunner config, real `agent_session` alarm
  with the VM restore held, and the real delivery runner mid-handoff.
- **Revert proof.** Gate disabled with `false &&`. Only "holds the wake prompt until the
  handoff commits, then delivers it into the live runtime" went red: the midpoint
  delivery returned `accepted` instead of `retry`. The three controls stayed green.
- **Pre-fix full reproduction** (temporary test, gate disabled):
  - the midpoint delivery was `accepted`, 1 prompt was submitted, and the batch became
    `delivered`;
  - the handoff then aborted, logging `check=project_event_wake_authority` at
    `task_runner.assert_recovery_authority` with the snapshot claim still `waking`;
  - the task went `sleeping` with "Wake attempt failed; saved conversation retained:
    Session recovery authority was revoked";
  - one VM stop was issued.

  This matches production exactly.

- The same file covers the second consumer: the woken agent calls `list_subscription_events`
  through the real MCP route with the runtime's own token while the restore is held. The
  batch becomes `delivered` and its wake row is withdrawn, then the handoff commits with no
  stop and no revocation. **Revert proof:** with `acceptConsumedByTarget: false`, only this
  test went red: the task went `sleeping` instead of `in_progress`. A table on the real
  ProjectData validator covers `pending`, `delivered`, `acked`, `cancelled` and `expired` in
  strict and live-wake modes, plus a cancelled subscription. Making the validator ignore the
  opt-in reddened exactly the strict `delivered` and `acked` cases.
- `tests/workers/vm-prompt-delivery-wake-handoff-gate.test.ts`, 10 cases against real D1.
  Each conjunct mutation reddened exactly its cases:
  - dropping the runtime check: Instant;
  - dropping the task-status check: committed and returned-to-sleep;
  - dropping the restored-workspace match: older-wake restore;
  - dropping the `waking` disjunct: both claimed-wake cases.
    The tenth case is a claim naming another project's task (the join's project scope).
- `tests/unit/services/session-recovery-authority-revocation.test.ts` (4) and the updated
  `task-runner-attempt-storage.test.ts` (3) cover the diagnostics.

## Acceptance criteria

1. Proven root cause is recorded (this file plus the PR) with production evidence.
2. A durable delivery cannot reach a VM wake runtime before `transitionToInProgress`
   commits; it is delivered promptly after commit via the wake-ready signal.
3. A live VM wake is not revoked when its own chat consumes the batch (reads or acks it)
   before the commit; cancellation, expiry and subscription changes still revoke, and the
   Instant guard stays strict.
4. The real-ordering test fails before the fix (handoff aborted by "authority revoked")
   and passes after; controls prove superseded attempts, terminal tasks, and genuinely
   revoked event authority still abort.
5. Every `SessionRecoveryAuthorityRevokedError` throw site logs its check and the
   snapshot claim fields; no secrets.
6. Production: count wakes since the deploy that failed with "Session recovery
   authority was revoked" (expected 0). The 7-day/50-wake soak is reported as pending
   with the rerunnable query.

## References

- `.claude/rules/39-debug-before-redesign.md`, `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `.claude/rules/58-terminal-verdicts-must-match-the-resumer.md`, `.claude/rules/61-guards-must-cover-every-runtime.md` (API scoped)
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- `tasks/archive/2026-10-07-wake-ready-prompt-delivery.md` (designed release path)
- `tasks/archive/2026-10-04-stable-task-identity-sleep-wake.md` (reactivation model)
- Process note: the task file lands with the PR (recent repo practice), not as a direct
  `main` commit, because a `main` push triggers CI and production deploy mid-wave.
