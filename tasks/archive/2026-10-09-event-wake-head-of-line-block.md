# Event wakes: one open wake must not silence a chat for 24 hours

## Problem

A matched project event (for example a GitHub CI completion) can fail to wake a chat for up to
24 hours, even while the chat is awake and idle, because another wake for the same chat is open.

Production incident, 2026-10-09 (EffProp project `01KMZ1YF0T3NBH62YH2GZ8CVWZ`, chat
`c0c769d2-2d6f-49af-88e2-307c73195286`, CI subscription `426b564e-de4f-45ca-80e9-53c328e439f5`,
SAM investigation task `01M4GHKAEHXX9MG467QPMJ6EMY`, root cause also on idea
`01M4E7F6JN191Q4B7H3KRB3N7H`):

1. 14:22:25Z a reviewer agent sent the chat a durable message. It became prompt-queue wake batch
   `8f069750-454b-4529-9dbc-632431a42041` (pending while the agent was busy; accepted 14:25:00Z).
2. 14:24:40Z the wake materializer saw that open batch via `readLivePromptBatchLeaseUntilForTarget`
   and called `deferWakeTarget`, which copied the batch's ~24 h `delivery_expires_at` /
   `readable_until` into `delivery_cooldown_until` of every active prompt-queue subscription on the
   chat, including the CI subscription created 4 s earlier.
3. 14:26:27-45Z six CI completion events were admitted and matched on time. The CI subscription's
   cooldown kept `computeProjectEventMaterializationAlarmTime` from scheduling the wake section, and
   the 15-minute full run at 14:34:58Z skipped it in `selectWakeCandidates`. No wake was queued.
4. The agent pulled the events manually after the human asked "Status?". The pull batch reported
   `resolvedDelivery: "unsupported"`, which misled diagnosis.

## Research findings

- `project-events-wake-targets.ts` `readLivePromptBatchLeaseUntilForTarget` treats a target as
  occupied while any prompt-queue batch is `pending` (until `delivery_expires_at`, 24 h) or
  `delivered` and unacknowledged (until `readable_until`, 24 h). Defaults:
  `DEFAULT_PROJECT_EVENT_WAKE_PROMPT_TTL_MS` and `DEFAULT_PROJECT_EVENT_WAKE_READ_GRACE_MS` (24 h)
  in `packages/shared/src/constants/project-events.ts`.
- `project-events-materialization.ts` `runProjectEventWakeMaterializationBatch` defers an occupied
  target with `deferWakeTarget(..., liveBatchLeaseUntil)`. `deferWakeTarget` only ever extends
  `delivery_cooldown_until`, writes it on every subscription for the target, and nothing clears it
  when the blocking batch is accepted, acknowledged, cancelled or expires. So even acknowledging
  the first wake does not release the others.
- The eventing plan (`tasks/archive/2026-09-06-eventing-delivery-scheduling-channels.md`) requires
  "one in-flight wake per target". A later review (`tasks/archive/2026-09-07-event-wake-review-fixes.md`,
  "Read-grace occupancy") extended occupancy to delivered-but-unacknowledged batches and required
  "Acknowledge/expiry must release occupancy without empty loops". The stamping breaks that
  requirement. Public docs state the resulting behavior: `apps/www/src/content/docs/docs/guides/agents.md`
  "An unacknowledged event notification delays further notifications to that chat".
- Raphaël approved fixing the 24 h block on 2026-10-09 (this conversation).
- `agent-message-subscriptions.ts` `hasPendingWake` / `hasQueuedWake` already define "a prompt-queue
  wake not yet delivered" as `state = 'pending'`.
- The prompt-delivery runner (`prompt-delivery-runner.ts`) applies every runtime result through
  `advanceProjectEventPromptAttemptCheckpoint` and then `await hooks.recalculateAlarm()`, so a
  queued wake leaving `pending` through the runtime path re-schedules the wake section at once.
  Cancellation, ack and pull RPCs (`index.ts` `cancelProjectEventSubscription`,
  `ackProjectEventDelivery`, `listProjectEventSubscriptionEvents`, `getProjectEvent`) do not
  recalculate the alarm.
- `readProjectEventWakeLeaseUntil` in `project-events-wake-delivery.ts` is a different lease (keeps
  reconciliation check-ins and attention expiry off a session that is legitimately waiting). It is
  out of scope and unchanged.
- Rule 47 req. 10: a section's alarm must come from the same query the sweep selects with; a
  blocked row must not re-arm the alarm at its floor. The occupancy condition therefore has to be
  one shared SQL predicate in both `selectWakeCandidates` and `computeProjectEventMaterializationAlarmTime`.
- The index `idx_project_event_batches_prompt_target` (`project_id`, `delivery_channel`,
  `target_session_id`, `state`, `updated_at`, `id`) covers an occupancy `NOT EXISTS` probe.
- The query-plan test in `apps/api/tests/workers/project-data-events.test.ts` hand-copies the alarm
  SQL; it must use the shared predicate to stay meaningful.
- Existing subscriptions in production may already carry a stamped ~24 h cooldown. A one-time DO
  migration must release them so the fix applies to waits created before deploy.
- `project-events-pull.ts` `createPullDeliveryBatch` runs `resolveProjectEventDelivery` with no
  adapters, so every injecting mode resolves to `unsupported` for a pulled event.
- Tests encoding the old stamping: `project-data-events.test.ts` (blocked-target fairness tests
  assert `delivery_cooldown_until` equals the lease) and `agent-message-wake-starvation.test.ts`
  ("The first wake still has its 24-hour lease", `capacity_deferred`).

## Implementation checklist

- [x] Define target occupancy as "a prompt-queue wake for this chat is still pending delivery" in one
      exported SQL predicate (pending batch with a live `delivery_expires_at`); accepted (delivered)
      wakes no longer hold the chat, whether or not they are acknowledged
- [x] Use that predicate in `selectWakeCandidates` and `computeProjectEventMaterializationAlarmTime`
- [x] Remove the lease-based deferral (`readLivePromptBatchLeaseUntilForTarget` and its
      `deferWakeTarget` call); keep the short capacity deferral
- [x] Recalculate the ProjectData alarm after pull, ack and cancel RPCs, which can end a queued wake
      outside the alarm
- [x] DO migration `063` releasing stamped cooldowns on active prompt-queue wake subscriptions and
      recomputing their `wake_due_at`
- [x] Pull-created batches record `recorded_not_injected` (or `record_only`) instead of `unsupported`
- [x] Regression test through the real MCP/admission path reproducing the incident: open DM wake on a
      chat, CI event matched for another subscription on the same chat, CI wake materializes once the
      DM wake is accepted, with no acknowledgement; control: no second wake while the first is still
      pending; subscription cooldown is never stamped with the lease
- [x] Scheduler/sweep loop test: while the chat is occupied the wake section does not re-arm; after
      acceptance it fires once and materializes
- [x] Migration test: stamped cooldown released, `wake_due_at` recomputed, legit rows untouched
- [x] Pull label test (worker or resolver unit test)
- [x] Update tests that encoded the old stamping and the query-plan test
- [x] Update docs: `apps/www/src/content/docs/docs/guides/agents.md` (unacknowledged notification
      sentence), architecture overview if needed, MCP tool text if it describes ack gating
- [x] Prove discrimination: revert the fix and confirm the regression test goes red

## Acceptance criteria

- [x] A chat with a delivered but unacknowledged wake receives the next matching event's wake as soon
      as the prompt queue can deliver it (no 24 h hold)
- [x] At most one undelivered (pending) wake batch exists per chat at any time
- [x] No code path copies a wake batch's expiry into another subscription's cooldown
- [x] Existing stamped subscriptions are released by the migration
- [x] A pulled event never reports `resolvedDelivery: "unsupported"` for a supported subscription
- [x] The wake alarm section does not re-arm in a loop while a chat is occupied
- [x] Staging: an agent chat with an open, unacknowledged wake is woken by a second subscription's
      event without acknowledging the first
- [x] Lint, typecheck and build pass locally; the full unit and Workers suites run as required PR
      CI checks before merge

## Implementation notes

- Discrimination (rule 62): with the `apps/api/src` changes stashed, all five tests in
  `tests/workers/project-event-wake-target-occupancy.test.ts` went red (blocked CI subscription
  still scheduled, `unsupported` pull label, migration absent); restored, all five pass.
- Three existing tests encoded the stamping and were updated to the new contract:
  `project-data-events.test.ts` (two blocked-target fairness tests now assert
  `delivery_cooldown_until: null`) and `agent-message-wake-starvation.test.ts` (`no_due_work`
  instead of `capacity_deferred`).
- Miniflare shares one env object between the test worker and the ProjectData DO, so the new
  tests do MCP setup with wakes/durable delivery on, then switch both off (`withQuietAlarms`) and
  drive materialization and acceptance explicitly.
- Prettier drift in `migrations.ts` and `project-data-events.test.ts` pre-exists on `main` and is
  outside the changed hunks; left alone.

## Staging verification (2026-10-09)

Driver: an Instant Claude Code chat A in staging project Potato subscribes to two agent channels X
and Y (`existing_session_prompt`), then ends its turn; chat B publishes to X, then Y.

- Before, without the fix (deploy run 37946788940 of PR #2291's branch, since merged to `main`):
  chat A `0c8276c4-e4d9-47b2-b1e5-4df6b541741b`.
  X's wake (batch `478f9aa8-e9f6-45bf-9584-ad8ccfbec833`) was delivered at 15:55:53Z. Y's event
  matched but produced no wake through 16:03:58Z (8.5 min). Bug reproduced.
- After, on branch head `2a6faf1f0` (deploy run 37956391403): chat A
  `5deeedde-13b1-4274-bc26-b2a2b760625d`, chat B `e3e37a57-04eb-48b7-80f7-96a30dd9f993`. X's wake
  (batch `b6bc29a2-1088-416d-b0ed-e49ddae39b22`) was delivered at 16:37:09.9Z and never
  acknowledged. Y's wake (batch `4a34647a-1d7a-4be9-b148-11d9b54718fd`) was created 1 s later and
  delivered at 16:37:14.9Z. The agent answered both wakes.
- After the deploy: no wake, scheduler, SQL or migration errors in staging logs; the test
  project's ProjectData alarm ran 18 ticks, 3 with the wake section, 0 failures (no re-arm loop).
- Desktop and mobile screenshots of the chat and Events page show both wakes, no horizontal overflow.
- All 7 test chats were stopped and their workspaces deleted.
- Unrelated issues found while testing, filed as ideas: an Instant runtime interrupted mid-turn
  left both queued wakes `dead_target` (`01M4GR94MHGTS41SKQAH9W3P0X`); a chat stopped by the user
  shows a "Failed" banner (`01M4GRNT9882NVT07TN1W2XX0W`).

## References

- `.claude/rules/62-tests-must-observe-the-real-trigger.md`, `apps/api/.claude/rules/47-control-loop-io-budget.md`
- `apps/api/.claude/rules/31-migration-safety.md` (DO migration safety), `.claude/rules/74-proxy-signals-must-match-the-condition.md`
- Idea `01M4E7F6JN191Q4B7H3KRB3N7H`
