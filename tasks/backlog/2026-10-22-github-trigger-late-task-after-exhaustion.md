# GitHub trigger recovery: a late task can start after a delivery is exhausted

## Problem

GitHub trigger recovery (`apps/api/src/services/github-trigger-recovery.ts`) checks its inbox
lease in `beforeSubmit`, but nothing fences the task insert itself. An attempt can pass
`beforeSubmit`, stall inside task submission past its lease, and finish after the delivery was
marked `exhausted`.

- **Overflow:** the run-slot clause (`EXECUTION_HOLDS_RUN_SLOT_SQL` in
  `services/trigger-run-slots.ts`) stops holding the slot once the inbox row leaves
  `pending`/`processing`. Another delivery can take the slot, and the stale attempt's task then
  exceeds `max_concurrent`.
- **Give-up ignores a started task:** the give-up also never checks whether the delivery's task was
  created after all. It reports exhaustion and alerts operators for a run that actually started.

## Context

Found while fixing the same race for agent email in draft PR #2413, from Astra High's re-review
([comment](https://github.com/raphaeltm/simple-agent-manager/pull/2413#issuecomment-6351355936)).
The email fix:

- refuses a task insert for an execution whose email was rejected (the trigger insert guard in
  `services/reserved-task-submission-storage.ts`);
- accepts instead of rejecting when the task exists (`closeDelivery` in
  `services/agent-email/inbound-delivery.ts`).

The GitHub inbox needs the equivalent. This is pre-existing behavior, not introduced by #2413.

## Acceptance Criteria

- [ ] The trigger task insert refuses an execution whose GitHub inbox row is `exhausted`, in the same
      statement as the insert
- [ ] Exhaustion checks for a task created for the delivery's execution and finalizes as completed
      instead of exhausted when one exists, without alerting
- [ ] A test through the real `submitReservedTask` holds a submission past exhaustion, admits another
      delivery into the slot, then releases the stale submission and asserts no second task
- [ ] A control test shows a delivery that is only waiting for a retry still gets its task
- [ ] Each guard is proven discriminating (removing it fails exactly its test)
