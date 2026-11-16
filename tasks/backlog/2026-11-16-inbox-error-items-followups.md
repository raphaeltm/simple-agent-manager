# Inbox error items: follow-ups from slice E

Found while building inbox slice E (PR #2781, idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9).

## Problem

Slice E files `error` inbox items for failed starts, crashes, failed wakes, lossy sleeps, failing
automations and undelivered answers. These related gaps were left out of its scope (a provider-limit block superseding an open
failed-wake item was finished in the same PR):

1. A person's chat message delivered through the durable prompt outbox to an awake chat that ends
   `failed` (`max_attempts_exceeded`, `dead_target`) raises nothing visible. Only TTL expiry to a
   sleeping chat (now a wake-failure item) and InteractionStore / inbox-ask notice give-ups file
   items (`packages/project-data/src/do/prompt-delivery.ts:expireDuePromptDeliveries`,
   `applyPromptDeliveryResult`).
2. Read regressions of moving the wake failure into `asks` (same as questions in slice G): the
   account map (`apps/api/src/routes/account-map.ts`) reads only `session_summaries.attention_json`,
   and the agent-facing `pendingAttention` (`packages/operations/src/attention-core.ts`) lists
   only markers and question asks. Slice G left the account map in the same state for questions,
   so this is one fix for both kinds.

3. Sleep failures other than the bounded fallback file nothing: a sleep episode that ends
   `terminal_failed` (`apps/api/src/services/session-sleep-episode.ts`) and the deleted-workspace
   chat closure (`session-sleep-deleted-workspace.ts`). The fallback is the path that releases a
   workspace with possible loss; these two need their own wording and a decision on whether they
   mean loss.
4. An automation that repeatedly fails to start (executions `queued`/`dropped` with an error and no
   task, which `consecutiveFailureCount` counts as failures and auto-pause acts on) is not found by
   the automation sweep, which scans `status = 'failed'` runs. If such an automation is auto-paused
   before any run failed, no item says so. Needs the dropped-run shape added to the candidate scan
   with its own index.
5. Sleep-loss and undelivered-answer items have no automatic recovery signal: they close when the
   person writes in the chat (or archives them). That is deliberate (nothing else proves the person
   saw the loss), but it should be stated in the inbox guide.
6. Platform `cron_failure` notifications sent to superadmins (failed sweeps, archive breaker,
   capacity pool refresh) still link to their admin pages; they are installation-wide operator
   alerts, not one person's item, so they get no inbox item.
7. A provider-limit block closes the failed-wake item from inside ProjectData's
   `blockConcurrencyWhile` (one D1 UPDATE beside the existing D1 read there); moving both reads out
   of the lock is a separate refactor of `syncProviderLimitAttention`.

8. An Instant start whose first prompt fails (for example a 402 from the AI Gateway) does not fail
   the task: it stays `in_progress` / `awaiting_followup` with `error_message = 'agent_prompt_failed'`
   so the chat can retry, and the sweep files only for `tasks.status = 'failed'`, so no item is
   filed. Seen on staging2 2026-11-16 (task 01M7JFQRE7AV4VHK1Z2076SHBC). Slice F2's "Couldn't start
   · In Needs you" cannot rely on an item for this case until it is covered. Needs a decision on
   what closes such an item (the next successful prompt).
9. The VM-agent task callback sends its failure notification (and files inline) only after
   `revalidateWorkspace()`, which throws once the failed workspace is torn down, so a VM failure gets
   neither until the next sweep tick (up to 5 minutes later, which then files and notifies). Seen on
   staging2 2026-11-16 (task 01M7JG20EKZ14CF6TW7XY4M1H9: failed 15:42:18Z, item at the 15:45Z tick).

10. A run whose task the person cancelled is recorded as a `failed` execution
    (`trigger-execution-sync.ts`: every non-completed terminal status maps to `failed`, with a NULL
    error message), so it counts toward the failure streak. The existing auto-pause has always
    counted it; the automation item inherits that, so cancelling runs can file "failed its last N
    runs". The streak for the item (and arguably auto-pause) should skip cancelled runs.

11. A failing automation files one task item (and an `error` notification) for each failed run as
    well as its automation item at the threshold: on staging2 three failed runs of one automation
    made three "stopped before it finished" items plus "Automation … failed its last 3 runs". Decide
    whether a run of an automation should file only through its automation item (the threshold
    then governs when the person hears), and stack or suppress the run items accordingly.

12. Archiving a chat leaves its task's error items open (seen on staging2: twelve archived test
    chats, six task items still in Needs you). Spec section 7 says an archived chat's open items
    are cancelled with the reason shown; no slice implements that yet for any ask kind, so it
    belongs with the asks-wide archive handling rather than to error items alone.

## Acceptance Criteria

- [ ] Human prompt deliveries that fail terminally on an awake chat file one `delivery` error item
- [ ] Account map and `pendingAttention` read open wake-failure (and question) asks
- [ ] Decide and implement items for terminal sleep failures and deleted-workspace closures
- [ ] Automations that fail to start (dropped runs) file an item, with a test through admission
- [ ] Inbox guide states which error items close by themselves and which close when you write
- [ ] An Instant first-prompt failure files one item and closes on the next successful prompt
- [ ] A VM-agent failure callback files and notifies inline even when the workspace is already gone
- [ ] Cancelled automation runs do not count toward the automation item's failure streak
- [ ] Decide and implement how failed automation runs relate to the automation item (one alert per failure, not two)
- [ ] Archiving a chat cancels its open asks, error items included (spec section 7)
