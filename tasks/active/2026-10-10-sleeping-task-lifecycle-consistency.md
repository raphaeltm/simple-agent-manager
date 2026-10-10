# Make every lifecycle check treat a sleeping task consistently

**SAM task:** 01M4JRSWJFM36PDP37V28FB0XV (agent B, reliability wave `reliability-wave-1010`, coordinator 01M4JK3X7BART9SDKJ3KGCDE0Q)
**Branch:** `sam/every-lifecycle-check-treat-8fb0xv`
**Ideas:** 01M4E7F6JN191Q4B7H3KRB3N7H, 01M4E2Q4P9CFTW5RWAKHGEP0VC (queue 01M4DR7MBDD8AAVF1XMC2XYQEX)

## Problem

PR #2230 added task status `sleeping` (a slept VM task keeps its task and chat identity
instead of being replaced by a recovery task). Several lifecycle checks were never taught
what `sleeping` means, so three user-visible features break for slept VM tasks:

1. A scheduled `message_session` self-wake of a sleeping VM task fails permanently with
   "Scheduled target or creator authority is no longer active".
2. A `skip_if_running` trigger stays blocked while its previous run's task sleeps.
3. An evicted task-mode agent is told to "wait for and answer the latest queued follow-up
   message" when nothing is queued, so it stops mid-task.

## Research findings (verified 2026-10-10 on main a95b46191 and production)

### Vocabulary

- `sleeping` = the task released its runtime but keeps task + chat identity; durable
  messages, schedules and events can wake it. It does not occupy run/dispatch slots and
  cannot act as a live caller (`AGENT_TARGET_STATUSES` comment, `routes/mcp/_helpers.ts`).
- `awaiting_followup` is NOT a `TaskStatus` any more (it is an execution step), but several
  SQL allowlists still list it for legacy rows. Keep it in the shared live set.
- Transitions (`services/task-status.ts`): `sleeping` is reachable only from `delegated` /
  `in_progress`, so a sleeping task has always started.

### 1. Schedule authority (fix)

- `project-event-schedules-authority.ts` `requireScheduleAction` checks
  `t.status IN ('queued','delegated','in_progress','awaiting_followup')` — no `sleeping`.
- Runs at: fire time (`project-event-schedules-runner.ts` `runScheduleAlarm`, permanent
  failure in its catch), creation (`project-data/index.ts` `createProjectSchedule`),
  standing watches (`createProjectStandingWatch`), reconcile retries
  (`project-event-schedules-recovery.ts` `reconcileSchedule`).
- Downstream already accepts a sleeping source: `invalidScheduledDeliveryTarget`
  (chat active|sleeping; `isSessionRecoverySourceTaskGuardValid` = non-terminal source) and
  the delivery runner's `sourceTaskGuardForClaim` for `scheduled_action`.
- Existing test `tests/unit/durable-objects/project-schedules.test.ts` "queues atomically into
  the same sleeping conversation" only flips `chat_sessions.status`, leaving the task
  `in_progress` (Instant shape) — never the VM shape.
- Production 2026-10-08: schedules 4fa440b3…, ca52335a…, bc930673… failed this way.

### 2. Trigger admission (fix)

- `services/trigger-admission.ts` reserve INSERT and `classifyReservationFailure` both count
  executions with `e.status IN ('queued','running') OR (linked task NOT IN terminal)`; a
  sleeping task's execution stays `running`, and after the 48 h hard-max backstop marks it
  `failed`, the non-terminal (sleeping) task still counts.
- Same admission is shared by cron, GitHub, webhook, incident and manual-run triggers.
- Production: trigger "Daily blog post" 01KNSC6SQA94KA2QXB8WPJGW8Y, execution
  01M4E0T54RNPJRAPF9Q87T3XFM `running` since 10-08 15:06Z, task `sleeping`; the 10-09 fire was
  `skipped/still_running`; next fire 2026-10-10T15:05Z. DO NOT touch that chat/task.
- `scheduled/trigger-execution-cleanup.ts` doc comment says task liveness controls admission;
  update wording once sleeping releases the slot.

### 3. Eviction recovery prompt (fix)

- `session-sleep-fallback-messages.ts` `SESSION_RECOVERY_INITIAL_PROMPT` and the fallback
  variant end with "wait for and answer the latest queued follow-up message".
- `session-recovery-task.ts` `startRecoveryTask` sets `taskDescription` from
  `sessionRecoveryInitialPrompt(...)`; it already receives `SessionRecoveryOptions`.
- Only two `ensureSessionRecovery` callers: `vm-prompt-delivery-target.ts` (a delivery is
  queued) and `workspace-eviction-recovery.ts` (nothing queued; passes `evictionFence`).
- The initial prompt is sent only when the agent starts fresh (restore `degraded`, or no
  restore); a `restored` ACP session gets no prompt (`agent-session-bootstrap.ts`).
- Production: task 01M4DV4W134BJJ5PT04PCFYXQQ (chat 88ec54d3…) received exactly this prompt
  after eviction (message 32e68540…, 2026-10-08) and stalled.
- Fix without touching Agent A's `session-recovery.ts`: an explicit resume reason in
  `SessionRecoveryOptions` set by the eviction caller; prompt selection in `startRecoveryTask`
  (task mode + runtime lost → "continue your assigned task, don't repeat external effects").
  Conversation mode and delivery-triggered wakes keep today's wording.

### 4. Rule 79 audit (task-status allowlists over `sleeping`)

| Site                                                                                                                                                                                               | Decision                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project-event-schedules-authority.ts` target task status                                                                                                                                          | FIX → wakeable set                                                                                                                                 |
| `project-event-schedules-recovery.ts` `started` list (reconcile monitor)                                                                                                                           | FIX → sleeping has started                                                                                                                         |
| `trigger-admission.ts` reserve + `classifyReservationFailure`                                                                                                                                      | FIX → sleeping releases the slot                                                                                                                   |
| `routes/mcp/_helpers.ts` `ACTIVE_STATUSES` / `AGENT_TARGET_STATUSES`                                                                                                                               | Derive from the shared sets; semantics unchanged (callers/slots live-only, targets wakeable)                                                       |
| `webhook-trigger-store.ts:284` `isLinkedExecutionDurable`                                                                                                                                          | No change: sleeping falls through to `ensureTaskRunnerStarted`, which returns true because TaskRunner state is never deleted                       |
| `webhook-delivery-reconciliation.ts:84` `taskAdvanced`                                                                                                                                             | No change: same `ensureTaskRunnerStarted` fallback                                                                                                 |
| `project-event-channels-authority.ts:18`                                                                                                                                                           | No change: authorizes an awake caller                                                                                                              |
| `orchestration-stop.ts:178` CAS loop                                                                                                                                                               | No change (rule 67, destructive path): a child sleeping mid-stop yields a retryable error; a repeated stop succeeds because entry accepts sleeping |
| `orchestration-tools.ts:153` retry stops only live children                                                                                                                                        | No change (rule 67, destructive); note follow-up: retrying a sleeping child leaves the sleeping original wakeable                                  |
| `orchestration-dependency-tools.ts:274` error wording only                                                                                                                                         | No change                                                                                                                                          |
| `session-recovery-authority.ts` `LIVE_TASK_STATUSES_SQL`, `session-snapshot-recovery-lifecycle.ts:305`, `session-wake-ready.ts:39`, `session-sleep-teardown.ts:253`                                | Agent A's wake area; recovery-task liveness, correct to exclude sleeping                                                                           |
| stuck-task sweeps, node cleanup, idle-cleanup terminalization, container recovery failure, conversation timeout, stranded tasks, warm placement, provisioning authority, direct workspace creation | No change: destructive or runtime-occupancy checks; sleeping must NOT count (rules 58/67)                                                          |
| dispatch slot counts (`dispatch-tool.ts`), mission concurrency (`project-orchestrator/scheduling.ts`)                                                                                              | No change: sleeping releases slots                                                                                                                 |
| `reserved-task-submission.ts` `ALREADY_STARTED_STATUSES`                                                                                                                                           | No change: sleeping reaches `ensureTaskRunnerStarted` → admitted                                                                                   |
| `platform-feedback-incidents/*` lease (`NOT IN terminal`)                                                                                                                                          | No change: a sleeping triage task keeps its incident lease (out of scope)                                                                          |
| `project-lifecycle-event-inputs.ts:360`, `admin.ts:193`, `reconciliation-candidates.ts:198`                                                                                                        | No change: event vocabulary / display / awake-runtime reconciliation                                                                               |

### 5. Event delivery to a sleeping chat (prove)

- `project-events-materialization.ts` selects `c.status IN ('active','sleeping')`;
  `vm-prompt-delivery-target.ts` calls `ensureSessionRecovery` for a slept VM workspace.
- Existing tests stop at the queued inbox row. Add one real-path test through the delivery
  alarm + real `DefaultVmPromptDeliveryAdapter`.

## Implementation checklist

- [x] `services/task-status.ts`: add shared `LIVE_TASK_STATUSES` and `WAKEABLE_TASK_STATUSES`
      (+ SQL placeholder helper if useful); `_helpers.ts` derives `ACTIVE_STATUSES` /
      `AGENT_TARGET_STATUSES` from them
- [x] Schedule authority accepts wakeable (incl. sleeping) target tasks via bound params
- [x] Schedule reconcile `started` includes sleeping
- [x] Trigger admission: one shared slot predicate for reserve + classify; sleeping linked
      task does not hold the slot; update cleanup doc comment
- [x] `SessionRecoveryOptions.wakeCause` (explicit field); eviction caller
      sets runtime-lost; `startRecoveryTask` selects the prompt
- [x] `session-sleep-fallback-messages.ts`: continue-assigned-task wording (normal + fallback)
- [x] Test a: schedule created awake → real sleep teardown → schedule alarm admits, writes
      `scheduled_action` inbox row → delivery alarm through real adapter requests recovery;
      controls: completed task, suspended member refused; creation-time acceptance of a
      sleeping target
- [x] Test b: real `runCronTriggerSweep` fires while previous task sleeps (incl. hard-max
      failed execution); controls queued/delegated/in_progress still skip
- [x] Test c: eviction callback HTTP → task-mode prompt says continue + no external repeats;
      controls: conversation mode unchanged, user follow-up wake unchanged
- [x] Test d: event subscription → sleep → event → materialization → delivery alarm → real
      adapter requests recovery with the event-wake guard
- [x] Revert each fix once; record which test went red (d: revert sleeping in materialization)
- [x] Docs: grep public docs for affected behavior; update if they describe it
- [ ] Rule 79 audit table in PR

## Implementation notes

- Shared sets in `services/task-status.ts`: `LIVE_TASK_STATUSES`, `SLEEPING_TASK_STATUSES`,
  `WAKEABLE_TASK_STATUSES` (= live + sleeping), plus `taskStatusSqlList`. MCP `ACTIVE_STATUSES` /
  `AGENT_TARGET_STATUSES` now derive from them (same members; order normalized).
- Trigger admission: `EXECUTION_HOLDS_RUN_SLOT_SQL` is shared by the reservation INSERT and
  `classifyReservationFailure`. Only a linked `sleeping` task changes outcome; every other case
  (terminal task with an unsynced `running` execution, missing task row, draft/ready) behaves as
  before.
- Eviction prompt: `SessionRecoveryOptions.wakeCause = 'runtime_lost'` is set only by
  `recoverWorkspaceAfterEviction`; `startRecoveryTask` picks `continue_assigned_task` only for
  task mode (the same effective task mode the TaskRunner config uses, contract first).
  `session-recovery.ts` (Agent A) is untouched; SHARED_FILE published for
  `session-recovery-eviction.ts`.
- The recovery prompt reaches the agent only when it starts a fresh ACP session (degraded or no
  restore). A `restored` session gets no prompt at all; out of scope here.

### Discrimination evidence (each fix reverted once)

| Revert                                                            | Red                                                                                                                                                          | Green controls                                                  |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| Trigger sleeping exclusion removed                                | 2 × "admits the next cron fire while the previous run sleeps", "admits the next fire after the real hard-residence backstop"                                 | queued/delegated/in_progress skips, max_concurrent live control |
| Schedule authority back to the pre-fix list                       | "admits the schedule, queues the scheduled message and asks to wake the slept chat", "accepts a new self-wake schedule created after the task already slept" | completed-task and suspended-member controls                    |
| Schedule authority status predicate deleted                       | "still refuses the self-wake when the task completed while it slept"                                                                                         | others                                                          |
| Reconcile `started` without sleeping                              | "observes sleeping without replaying task admission"                                                                                                         | 18 others                                                       |
| Eviction `wakeCause` removed                                      | 2 task-mode eviction cases                                                                                                                                   | conversation-mode eviction, user follow-up wake                 |
| `startRecoveryTask` task-mode gate removed                        | "keeps the conversation-mode wording after an eviction"                                                                                                      | 3 others                                                        |
| Wake materialization `c.status = 'active'` only (pre-#2266/#2292) | "delivers a pull request event to the slept chat and asks to wake it"                                                                                        | others                                                          |
| Delivery target drops the `sleeping` workspace recovery branch    | schedule self-wake + event wake delivery cases                                                                                                               | controls                                                        |

## Acceptance criteria

- [x] A `message_session` schedule targeting a slept VM task is admitted and requests a wake
- [x] A skip_if_running/max_concurrent trigger fires when the previous run's task sleeps;
      live previous runs still block
- [x] Eviction recovery of a task-mode agent tells it to continue its assigned task without
      repeating external effects; conversation mode and follow-up wakes unchanged
- [x] Event wake delivery to a slept VM chat requests recovery through the real adapter
- [x] One shared live/wakeable status set used by the fixed checks
- [x] Every new guard proven discriminating by reverting it
- [ ] Production: next "Daily blog post" fire admitted (trigger_executions), or note when checkable

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`
- `packages/shared/.claude/rules/79-new-enum-values-audit-every-denylist.md`
- `apps/api/.claude/rules/67-shared-predicates-that-trigger-actions.md`
- `.claude/rules/74-proxy-signals-must-match-the-condition.md`
