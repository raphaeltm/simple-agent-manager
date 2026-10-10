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

| Task | Failure | Delivery | Accepted | `step_error` |
| --- | --- | --- | --- | --- |
| `01M4GED49YASA7D7QFG7AW3XA0` | 10-09 15:45 | `1bbc0690…` (CI-subscription chat) | 15:45:04.689 | 15:45:05.823 |
| `01M4FXMYCFTNMT3JTV41HVW14R` | 10-09 18:19 | `141b67f6…` agent-DM batch | ~18:19:01.36 | 18:19:02.030 |
| `01M4ABRWV97F54MQ1FFJFGHMBA` | 10-09 00:24 | `904f6fd9…` agent-DM batch | ~00:24:32.35 | 00:24:33.111 |
| `01M4GED49YASA7D7QFG7AW3XA0` | 10-10 00:49 | `782204e8…` (same CI chat) | ~00:49:49.65 | 00:49:50.710 |

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
   `rc.assertRecoveryAuthority` at the three handoff points). For an event wake this
   calls `validateProjectEventWakeRecoveryAuthority`, which requires `b.state =
   'pending'`. The wake's own successful delivery therefore reads as revocation →
   `SessionRecoveryAuthorityRevokedError` → `failTask` → `returnFailedWakeToSleep` →
   workspace stopped ("SessionHost stopped") and the accepted prompt's turn is killed.
   The batch stays `delivered`, so the event is not redelivered.

The window is from VM SessionHost registration to the handoff check, about 20–25 s in
the traces. Saturated `not_ready` retries run about every 80 s, which matches the
observed rate. Unguarded wakes (human follow-ups) have no event check, so they never
failed this way, but their prompt could still enter a runtime whose handoff later fails.

Writers the evidence idea suspected but which are **ruled out**:
`session-snapshot-prepare.ts` and `markSessionSnapshotSleeping` clear
`recovery_task_id`/`recovery_attempt_id`. That would have made the catch-time
`isCurrentRecoveryAttempt` false and suppressed `step_error`, and
`returnFailedWakeToSleep` would have refused. `restore-result` writes only
`restore_status`.

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
2. **Make every `SessionRecoveryAuthorityRevokedError` diagnosable.** The error carries
   a `check` discriminator, and every throw site logs `session_recovery.authority_revoked`
   with:
   - the check, the site, and the task, project, chat, and attempt IDs;
   - a best-effort read of the snapshot row: `recovery_task_id`, `recovery_attempt_id`,
     `recovery_status`, `capture_generation`, `sleep_status`.

   The diagnostic read never masks the original error and carries no secrets.
   `task_runner_do.step_error` also carries the check.

## Checklist

- [x] Root cause proven from production logs plus code; candidate writers ruled out
- [ ] Split TaskRunner recovery-authority methods out of `task-runner/index.ts`
      (789 lines; rule 18) in its own commit before behavior changes
- [ ] Gate in `services/vm-prompt-delivery-target.ts` with a comment naming the
      resumer predicate it mirrors (`isSessionWakeReadyCurrent`, `transitionToInProgress`)
- [ ] `SessionRecoveryAuthorityCheck` + `check` on the error; logging helper with
      snapshot-row diagnostics in `services/session-recovery-authority.ts`
- [ ] Every throw site names its check and logs: TaskRunner `assertRecoveryAuthority`,
      `advanceToStep`, `updateD1ExecutionStep` (×2), `putTaskRunnerState`,
      attempt-storage `setAlarm`, warm-node claim (`node-selection.ts`), Instant
      container source guard (`vm-agent-container.ts`)
- [ ] `task_runner_do.step_error` includes the authority check
- [ ] Workers vertical slice (new file): real agent-DM event wake → real snapshot claim
      and TaskRunner reactivation → real `agent_session` alarm with the VM restore
      call held → real delivery claim mid-handoff → release. Assert the handoff
      commits, the runtime is not stopped, and the prompt is accepted exactly once after
      the wake-ready signal
- [ ] Controls: superseded attempt still aborts; terminal (cancelled) task still
      aborts; genuinely revoked event authority (subscription cancelled) still aborts
      with check `project_event_wake_authority` logged
- [ ] Gate predicate table against real D1: waking+delegated holds; restored+delegated
      on this workspace holds; restored+in_progress ready; stale restored on another
      workspace ready; Instant (`cf-container`) restored+queued not held; terminal or
      sleeping task not held
- [ ] Diagnostics unit tests: each check logged with snapshot fields; diagnostic read
      failure does not mask the error; no secret-bearing fields
- [ ] Revert the gate once and record which test goes red (PR body)
- [ ] Rule 61 enumeration in PR: durable delivery (gated), reconciliation check-in
      (`agent_mailbox`, active chat plus long idle; not an event batch), Instant (not a
      TaskRunner wake)
- [ ] Docs: update public docs that describe when queued prompts start after a wake
- [ ] Lint, typecheck, focused and full API tests (sequential), build
- [ ] Local specialist reviews + task-completion-validator
- [ ] Staging: one real VM wake via a queued event or DM (STAGING_CLAIM/RELEASE, clean up)
- [ ] PR, CI, CodeRabbit request and wait, SonarCloud, merge, production deploy and
      release check

## Acceptance criteria

1. Proven root cause is recorded (this file plus the PR) with production evidence.
2. A durable delivery cannot reach a VM wake runtime before `transitionToInProgress`
   commits; it is delivered promptly after commit via the wake-ready signal.
3. The real-ordering test fails before the fix (handoff aborted by "authority revoked")
   and passes after; controls prove superseded attempts, terminal tasks, and genuinely
   revoked event authority still abort.
4. Every `SessionRecoveryAuthorityRevokedError` throw site logs its check and the
   snapshot claim fields; no secrets.
5. Production: count wakes since the deploy that failed with "Session recovery
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
