# Restored task-mode agents must receive the eviction "continue" prompt

SAM task `01M4K6Y4P7K9277RTS6GKQ22WD` (reliability-wave-1010, agent B2). Finishes fix #2 of the
wave, idea `01M4E2Q4P9CFTW5RWAKHGEP0VC` ("evicted task agents stall"), item 5 of idea
`01M4JVVG3K1BP55ANVKMGFHTHW`.

## Problem

PR #2295 (`272023b69`) made an eviction recovery tell a task-mode agent to "continue your assigned
task" instead of waiting for a queued message (`wakeCause: 'runtime_lost'`,
`recoveryNextStep` in `services/session-recovery-task.ts`). That prompt travels as the TaskRunner
`taskDescription`, which reaches the agent only as `visibleInitialPrompt` in
`startAgentSessionOnNode` (`services/agent-session-bootstrap.ts`).

Every recovery restores the saved harness session first (`resumeSnapshotChatSessionId` →
`restoreSnapshotChatSessionId`). When the VM agent's LoadSession restore returns `restored`,
`shouldStartFreshSession` stays `false` and `startAgentSessionOnNode` is never called. A queued-message
wake is fine (the queued message is delivered after the wake commits), but an eviction queues
nothing: the restored task-mode agent gets no prompt and idles silently. That violates policy
`fe8b57c6` ("fail visibly when agents silently stall"). PR #2295's test asserts only the TaskRunner
start config, so it could not observe this.

## Research Findings

1. **Signal**: `startRecoveryTask` alone knows `nextStep`; only the TaskRunner config crosses into the
   runner. `evictionFence` correlates with `runtime_lost` today but is a proxy (rule 74), so the
   condition must travel explicitly: a new config field `restoredSessionPrompt`.
2. **Restore vs fresh is known only inside bootstrap** (`shouldStartFreshAfterSnapshotRestore`). The
   bootstrap result must say whether the wake's first prompt was sent (`initialPromptSent`).
3. **The prompt is queued after the ProjectData wake commit, not inside bootstrap.** Eviction
   finalization runs `finalizeWorkspaceLifecycleClosure` before recovery; the snapshot is not yet
   marked sleeping, so `finalizeProjectDataSession` stops the ProjectData chat session, which keeps
   pointing at the evicted workspace. Accepting a delivery records message activity for the chat's
   current workspace (`runAcceptedPromptDeliveryHooks` → `updateMessageActivity`), so queueing
   inside bootstrap would re-create idle tracking for the evicted workspace that finalization just
   removed. `wakeSessionForSnapshotRecovery` (`allowStopped`) re-points the chat at the replacement
   workspace; it runs in `agent-session-step.ts` after bootstrap returns. So the enqueue belongs in
   the TaskRunner step, after `wakeSessionForSnapshotRecovery` / `completeSessionSnapshotRecovery`
   and before `transitionToInProgress`. (Correction: an earlier draft claimed `persistMessage`
   rejects stopped sessions; only the VM batch path `persistMessageBatch` does.)
4. **Ordering after the commit comes from agent A's hold** (branch `sam/fix-vm-wake-regression-6vwaw0`,
   task `01M4JRRD41T0X1TER0C56VWAW0`): `isVmWakeHandoffPending` in `vm-prompt-delivery-target.ts`
   retries every durable delivery to a VM wake whose task is still `queued`/`delegated` with the
   snapshot claim `waking` or `restored` for this workspace. `transitionToInProgress` →
   `notifyWakeSettled` → `signalSessionWakeReady` → `nudgePromptDeliveriesForTarget` then releases it.
   A `not_ready` retry does not spend the delivery attempt budget.
5. **Exactly once**: the VM restore is idempotent per `(workspace, agent session)`
   (`runSessionRestore` returns the cached attempt), so a retried step cannot flip `restored` → fresh.
   Reactivation resets `stepResults.agentSessionId`, so the new agent session id is unique per wake
   and stable across that wake's retries: deliveryId `checkpoint-continuation-<agentSessionId>`.
   The enqueue precedes the first persist of `agentStarted = true`, so a crash after that persist
   cannot skip it (a crash before it re-runs bootstrap and re-enqueues idempotently).
6. **Source kind**: `checkpoint_continuation` is in `PROMPT_DELIVERY_SOURCES` since #1785 (durable
   sleep/recovery) and has no producer or consumer (the long-turn supervisor config is unused).
   Reusing it avoids a new persisted enum value that older code could not parse after a rollback
   (`row-schemas/mailbox.ts` picklists the shared list). Rule 79 audit of predicates over the kind:
   - `prompt-delivery-runner.ts` `sourceTaskGuardForClaim` (allowlist) → add: a re-wake caused by
     this prompt must be guarded by its task, or `reactivateSleepingTask` (guard = 0) can revive a
     terminal task.
   - `prompt-delivery.ts` `listExpiringWakeDeliveries` (allowlist) → add: a continuation that expires
     while the session sleeps must raise a visible wake failure.
   - `prompt-delivery.ts` `failParentWakeDeliveries`, `prompt-delivery-runner.ts`
     `invalidParentWakeTargetResult`, event-wake and schedule validators → equality on their own kind;
     unaffected.
   - VM agent never receives `sourceKind` (no rollout coupling).
7. **Delivery-time validation**: like `invalidProjectEventWakeSourceTaskResult`, a continuation whose
   task is terminal or no longer bound to the chat must fail quietly as `terminal_target` instead of
   reaching the wake path and raising a misleading wake failure.
8. **Instant (cf-container)**: `ensureSessionRecovery` refuses cf-container snapshots and eviction
   recovery is VM-only, so no Instant wake carries `runtime_lost`; the restored-session prompt is
   produced only by `startRecoveryTask` (VM). Recorded per rule 61.
9. **Durable delivery disabled** (`DURABLE_PROMPT_DELIVERY_ENABLED=false`): the alarm never delivers.
   Production uses the default (`true`, no Environment override); staging pins `true`. When disabled,
   persist a visible system notice telling the user to send a message, instead of a silent stall.
10. Public doc `apps/www/src/content/docs/docs/reference/vm-agent.md` (eviction paragraph) describes
    only the fresh-start path.

## Implementation Checklist

- [x] `session-sleep-fallback-messages.ts`: `sessionRecoveryRestoredPrompt(nextStep)` (continue
      prompt for `continue_assigned_task`, else `null`)
- [x] `agent-session-bootstrap.ts`: return `initialPromptSent` (false only when the restore resumed
      the saved session)
- [x] New `services/restored-session-prompt.ts`: `queueRestoredSessionPrompt` (durable delivery,
      `checkpoint_continuation`, deterministic id, disabled-delivery visible notice)
- [x] New `durable-objects/project-data/checkpoint-continuation-delivery.ts`: delivery-time task
      validation
- [x] After A's MERGED (b8361d63f, 16:49Z) + rebase + SHARED_FILE (channel seq 20 planned, 22 applied):
  - [x] `task-runner/types.ts` + `services/task-runner-do.ts`: `restoredSessionPrompt` config field
        (+ `index.ts` legacy normalization)
  - [x] `session-recovery-task.ts`: set `restoredSessionPrompt` from `nextStep`
  - [x] `task-runner/agent-session-step.ts`: queue the prompt after the ProjectData wake commit and
        before `transitionToInProgress`, only when `initialPromptSent === false`
  - [x] `prompt-delivery-runner.ts`: rule-18 pure-move split into `prompt-delivery-source-guards.ts`
        (own commit), then validator in the chain + `checkpoint_continuation` in
        `sourceTaskGuardForClaim`
  - [x] `prompt-delivery.ts`: `checkpoint_continuation` in `listExpiringWakeDeliveries`
- [x] `packages/shared` mailbox types: document `checkpoint_continuation`
- [x] Docs: `reference/vm-agent.md` eviction paragraph, `architecture/overview.md` delivery paragraph
- [x] Tests (rule 62, real path):
  - [x] Main: workers test drives the real eviction callback route → recovery → real TaskRunner
        `agent_session` alarm with restore `restored`; the continue prompt is held while the handoff
        is uncommitted and delivered exactly once after it commits
  - [x] Control: fresh start (restore `degraded`) sends the continue prompt once as the initial
        prompt and queues nothing
  - [x] Control: queued-message wake of a restored session delivers only the queued message
  - [x] Control: conversation-mode eviction recovery with a restored session gets no prompt
  - [x] Continuation outliving its wake (review): user cancel mid-handoff, and the eviction fence
        refusing the handoff, both drop it without waking or a wake failure (workers)
  - [x] Validator unit tests (live, terminal, unbound, cross-project, superseded, read failure,
        reconcile) on real SQLite with continuations from the production builder
  - [x] Step ordering + pre-queue authority re-check (unit)
  - [x] Guarded re-wake + TTL-expiry wake-failure tests for the kind
  - [x] Revert the fix once; record which test went red (see Progress Notes)

## Acceptance Criteria

- [x] A task-mode agent recovered after runtime loss (nothing queued) receives the continue prompt
      exactly once, whether its session started fresh or was restored via LoadSession
- [x] The restored-session prompt is delivered only after the wake handoff commits
- [x] Queued-message wakes get no extra prompt; conversation-mode recoveries get none
- [x] A continuation never revives a terminal task and never raises a misleading wake failure
- [x] Main test proven discriminating by reverting the fix
- [ ] CI green, specialist reviews recorded, CodeRabbit requested/waited, SonarCloud clean
- [ ] Merged and contained in a successful Deploy Production run

## Progress Notes

- 2026-10-10 ~16:15Z: wiring for A's files prepared and validated on a local scratch merge of A's
  branch (never pushed); patch at `.tmp/b2-wiring.patch`. Waiting for A's MERGED to apply it.
- Discrimination evidence (workers test, scratch): reverting the TaskRunner queueing reddens only the
  main case; an unconditional restored prompt reddens only the conversation and queued-message
  controls; dropping the `initialPromptSent` guard reddens only the fresh-start control (double
  prompt); queueing before the ProjectData wake reddens only the main case (`workspace_activity` on
  the evicted workspace). Runner guards: each allowlist/validator mutation reddens only its cases.

- 2026-10-10 ~16:50Z: A merged #2299 (b8361d63f). Rebased; A's merged versions of every touched
  file were byte-identical to the validated head (085a3461e). Applied as two commits: the
  pure-move runner split, then the wiring.
- Review round (7 local reviewers, all PASS). Changes made from their notes: the continuation is
  also dropped when a later wake queued a newer one for the same chat (`hasNewerContinuation`, an
  indexed ProjectData read), so two runtime losses before delivery cannot double-prompt; the unused
  `restoredAgentSessionId` metadata was removed (the delivery id already encodes the session); the
  step's restored-prompt local now carries the chat id; vm-agent.md wording ("No message is
  queued"); two workers cases for a continuation outliving its wake.
- Finding while testing: after the enqueue, `completeSessionSnapshotRecovery` has already run, so
  every later handoff failure terminalizes the task (verified: an eviction-fence change mid-handoff
  leaves the task `failed`, chat `failed`, snapshot recovery `failed`). A queued continuation
  therefore never re-wakes a re-slept chat in today's code; the guarded re-wake remains defense in
  depth and is covered at the runner level.
- Superseded check discrimination: neutralizing `hasNewerContinuation` reddens only the
  "superseded by a later wake" case. Removing the validator from the runner chain reddens the two
  workers "outlives its wake" cases (a misleading wake failure is raised instead).
- Staging: not run. The optional eviction check would require driving a staging VM into
  system-wide memory exhaustion (devcontainers have no per-container memory limit), which is not a
  safe, deterministic trigger. The delivery-after-commit mechanics were live-verified on staging by
  #2299 (run 38060861687).

## Live Evidence Plan

Production evictions are rare (3 in the 7 days before #2295, 0 since). Do not force an eviction.
Before the fix, two of those three task-mode agents idled after recovery until SAM slept them
(`01M4DV5NEPH267ZZ6WQJT83AZB` 13:53→15:37Z and `01M4DV4W134BJJ5PT04PCFYXQQ` 13:57→14:17Z on
2026-10-08). For the next real eviction after the deploy, query production D1 `sam-prod`:

```sql
SELECT w.id AS evicted_workspace, w.eviction_finalized_at, s.chat_session_id,
       s.recovery_task_id, s.recovery_workspace_id, s.recovery_status,
       t.status AS task_status, t.task_mode
  FROM workspaces w
  JOIN session_snapshots s ON s.eviction_recovery_workspace_id = w.id
  LEFT JOIN tasks t ON t.id = s.recovery_task_id
 WHERE w.eviction_finalized_at > '<deploy time>'
 ORDER BY w.eviction_finalized_at DESC;
```

For a task-mode row, confirm the Workers log `restored_session_prompt.queued` for that chat (or, on
a degraded restore, a fresh start), the "Resume your assigned task" message in the transcript
followed by agent activity, and no `in_progress → sleeping` "VM conversation sleep completed"
event right after the recovery's `delegated → in_progress`.

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `.claude/rules/74`, `.claude/rules/79`,
  `.claude/rules/61`, `.claude/rules/58`
- PR #2295, A's branch `sam/fix-vm-wake-regression-6vwaw0`
- Ideas `01M4E2Q4P9CFTW5RWAKHGEP0VC`, `01M4JVVG3K1BP55ANVKMGFHTHW`, `01M4DR7MBDD8AAVF1XMC2XYQEX`
