# Inbox slice E: system error items

SAM task `01M7HDVC5BV0MZ91V0AR9CK5XT`, spec idea `01M7G03ZCQ6TM6CMEYDRKQ8ST9` (section 1 decision 3, section 6 slice E).
Branch `sam/implement-slice-e-inbox-9ck5xt`.

## Problem

System failures are invisible unless the person opens the affected chat. SAM must file one `error`
inbox item per failing thing, update it in place on repeat failures, close it when the thing
recovers, and never file one for a normal lifecycle ending (policy a974b04f).

## Research findings (code paths)

Failure points (writers of `tasks.status='failed'`, 16 of them):

- VM start: `durable-objects/task-runner/state-machine.ts:failTask` (no notification today).
- Instant start: `services/instant-session.ts:615`, `services/submit-instant-task.ts:182`,
  `routes/chat-start.ts:252`, `routes/mcp/dispatch-instant.ts:102` (`transitionTaskToTerminal` /
  `markTaskFailedIfNonTerminal`, step `launch_failed`).
- Dispatch/session/runner start: `routes/mcp/dispatch-tool.ts`, `services/submit-task-implementation.ts`,
  `routes/tasks/run.ts`, `sam-session/tools/dispatch-task.ts`, `retry-subtask.ts`, `orchestration-tools.ts`.
- Crash/stall after start: `routes/tasks/callback.ts` (VM agent prompt failure; only path that
  sends `notifyTaskFailed`), `scheduled/stuck-tasks.ts:recoverStuckTasks` (dead runtime, stall
  verdict, time limit), `services/node-stranded-tasks.ts` (lost heartbeat),
  `project-data` reconciliation dead target / idle cleanup.
- Normal endings that also write `failed`: parent retry stop (`orchestration-tools.ts:163`, text
  "Stopped by parent for retry"), human-input expiry (`project-data/src/do/attention-expiry.ts`),
  user PATCH (`routes/tasks/crud.ts:532`).
- Existing classification: `transitionTaskToTerminal({lifecycleOutcome})` writes `cancelled` /
  NULL `error_message` for normal endings; `classifyFailure()` (`packages/shared/src/failure-classification.ts`)
  marks `cancelled` (user/parent stop, superseded wake) and `input-expired` as `diagnosable:false`.
- Failed wake: `packages/project-data/src/do/wake-failure.ts:raiseSessionWakeFailure` writes the
  `wake_failed` attention marker; copied to `session_summaries.attention_json`
  (`getAttentionSummary`, needs_input wins). Readers: chat list (D1 index + DO), session detail,
  account map, connector chatsList/projectsList, attention-core, web `getAttentionState`.
  Cleared only by a human prompt/message or provider-limit supersede.
- Automations: auto-pause at admission `services/trigger-admission.ts:242-261`
  (`TRIGGER_AUTO_PAUSE_AFTER_FAILURES`, default 3), failure streak
  `services/trigger-failure-window.ts:consecutiveFailureCount`, run status
  `services/trigger-execution-sync.ts:syncTriggerExecutionStatus`; resume via
  `services/trigger-status.ts:triggerStatusUpdates` (REST PATCH, `sam_schedule_update`, MCP update_trigger).
  No notification on auto-pause today. `cron_failure` is superadmin-only platform sweep failure.
- Sleep with possible loss: `services/session-sleep-fallback.ts:runSessionSleepFallback`
  (`recoveryPoint` null/partial), only a chat system message today.
- Undelivered answers: InteractionStore `recordDelivery(..., 'unconfirmed')`
  (`durable-objects/interaction-store.ts`); durable prompt outbox terminal failure for human senders.
- ACP permission requests: `durable-objects/interaction-store-attention.ts:projectInteractionAttention`
  creates the marker, sends no notification. `request_human_input` sends `notifyNeedsInput`.
- Retry: SAM `retrySubtask` (`sam-session/tools/retry-subtask.ts`, owner, failed|cancelled → new task).
  Wake: `services/session-recovery.ts:ensureSessionRecovery` (VM), authorized by `authorizeAgentWake`.

## Design

- `asks` kind `error`, filed through `createAsk` with `dedupeKey` `error:<source>:<id>`;
  repeat failure updates the open row (`failure_count`, `body_md`, `updated_at`); recovery closes it
  (`done`, `answer_json {resolution:'recovered'}`, `notified_at` set, dedupe key released).
- Answer spec `{type:'actions', actions:[{id, label}]}` with ids retry|wake|resume|open_chat;
  answer body `{action}` runs the existing operation with the caller's authority.
- Task failures filed by a cron step (one candidate scan over `status='failed'`, KV watermark) so
  every writer is covered; the VM-agent callback files inline so its `error` notification links the item.
- Body text comes from `classifyFailure().explanation`, never from raw error text.

## Implementation checklist

- [x] Migration 0248: `asks.failure_count`, partial indexes (failed tasks, error items by task, error keys, failed runs, open error items per chat)
- [x] Shared types: `actions` answer spec, `InboxItem.failureCount/updatedAt`, `InboxAnswerRequest.action`, `INBOX_ERROR_ACTIONS`
- [x] Settings: `inbox.automationFailureThreshold`, `inbox.errorSweepBatchSize`, `inbox.errorLookbackMinutes`
- [x] Error filing core `packages/operations/src/inbox-error-core.ts` (file / update in place / resolve; never throws)
- [x] Normal-ending classification reused: `lifecycleOutcome` (no error), actor `user`, `classifyFailure().diagnosable`
- [x] Task failure cron step (`apps/api/src/services/inbox/system-errors.ts:runInboxSystemErrorSweep`) + inline filing in `routes/tasks/callback.ts` with the `error` notification linking the item
- [x] Retry closes the item in both retry implementations (`retry-subtask.ts`, `orchestration-tools.ts`); a task leaving `failed` closes it (sweep)
- [x] Automation failing/paused filing + close on clean run/resume/disable (`automation-errors.ts`), `cron_failure` notification on a new item
- [x] Failed wake → `asks` row via ProjectData port `inboxErrors.fileWakeFailure` (`wake-failure.ts`); marker no longer written; chat list reads it through `readOpenQuestionAttention` / `preferAttention`; ranking predicate includes it
- [x] Wake item closes when the chat wakes (`session-wake-ready.ts`) or the person writes in the chat (`closeChatErrorAsksForHumanMessage`)
- [x] Sleep fallback with possible loss → item (`session-sleep-fallback.ts` → `fileSleepLossError`)
- [x] Undelivered permission answer (InteractionStore `delivery_unconfirmed`) → item (`interaction-store-attention.ts`)
- [x] Actions: retry (`retrySubtask`), wake (`authorizeAgentWake` + `ensureSessionRecovery`), resume (`triggerStatusUpdates` CAS, `task:write`); archive without agent notice
- [x] Permission/form/URL request notification, once per request, linking the inbox item (`notifyInteractionRequested`)
- [x] Tests: real writers + sweep, exclusions with liveness, tenancy on real SQL, canary secret, actions, recovery, automations, wake read/close, Workers interaction tests
- [x] Docs: api reference (system error items), notifications guide, admin settings
- [ ] Rebase onto main after slice G (#2780) merges (part 6 is built on G's reader)
- [ ] Staging verification (staging2 queue: F1 → C → G → E)

## Notes

- Round trips: task filing ≈ settings + member + task check + insert (+ dedupe read + update on repeat); cron steps: one indexed scan + bounded filings + one UPDATE (tasks); automations: one scan + one streak read per automation (≤ batch) + one read per open item (≤ 4×batch). Chat list: the question reader gained a UNION ALL arm (same round trip); ranking EXISTS gained an OR arm.
- Undelivered answers: InteractionStore `delivery_unconfirmed` (permissions) and asks whose notice the inbox sweep gave up on (`fileUndeliveredAskAnswers`). Not covered: durable prompt outbox terminal failures to an awake chat (`max_attempts_exceeded`) for human chat messages; agent-facing `pendingAttention` no longer lists the (unanswerable) wake marker; account map no longer shows wake failures (same as questions after slice G).

## Acceptance criteria

- A real failed start files one item for the task owner; a second failure of the same thing updates it.
- Retry through the inbox answer route starts a new task and closes the item.
- A paused/failing automation files one item; resume closes it.
- Normal endings (cancel, parent stop, input expiry, user stop/PATCH, completion, superseded) file nothing.
- Item bodies never contain raw error text.
- Items are visible only to the assignee; foreign-project access is not-found.
- Permission requests send one high-urgency notification linking the inbox item.
