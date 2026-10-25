import * as v from 'valibot';

import { authorizeProjectOperation } from './authorization';
import { ScheduleCancelInput, ScheduleCreateInput, ScheduleUpdateInput } from './schedule-inputs';
import { getSchedule, listSchedules, SCHEDULE_KINDS } from './schedule-reads';
import { cancelSchedule, createSchedule, updateSchedule } from './schedule-writes';
import { defineOperation } from './types';

export { scheduleCreateStartsWork } from './schedule-inputs';

const id = v.pipe(v.string(), v.minLength(1));

export const samSchedulesList = defineOperation({
  name: 'sam_schedules_list',
  title: 'List schedules',
  description:
    "Use this when you need a project's scheduled work: one-off schedules (run once) and recurring ones (cron). Each has its state or status, next run in UTC and in its own time zone, target chat or agent profile and skill, attempts, creator and expiry, and a SAM link. Prompts are short untrusted previews; sam_schedule_get has the whole prompt and the run evidence. kind filters one_off or recurring; sessionId lists only one-off schedules that message or were made from that chat. Continue with nextCursor. Reads never wake compute.",
  kind: 'read',
  input: v.object({
    projectId: id,
    kind: v.optional(v.picklist(SCHEDULE_KINDS)),
    sessionId: v.optional(id),
    cursor: v.optional(id),
    limit: v.optional(v.pipe(v.number(), v.minValue(1), v.integer())),
  }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return listSchedules(ctx, input);
  },
});

export const samScheduleGet = defineOperation({
  name: 'sam_schedule_get',
  title: 'Get schedule',
  description:
    "Use this when you need one schedule in full and what has happened so far. For a one-off schedule, phases keep apart accepted (SAM recorded it), admitted (when due, the action went to message delivery or task submission), executionStarted (the agent began) and taskOutcome; unknown means SAM has no evidence either way. For a recurring schedule, recentRuns lists the latest runs: queued (task not yet submitted), running (task submitted), completed or failed (the task's outcome), skipped (see skipReason). Whether the owner was notified is not tracked. Reads never wake compute.",
  kind: 'read',
  input: v.object({ projectId: id, scheduleId: id }),
  async run(ctx, input) {
    await authorizeProjectOperation(ctx, input.projectId);
    return getSchedule(ctx, input.projectId, input.scheduleId);
  },
});

export const samScheduleCreate = defineOperation({
  name: 'sam_schedule_create',
  title: 'Schedule work',
  description:
    'Use this when the user wants work to happen later. Give runAt for a one-off schedule or cron for a recurring one. runAt is an instant with Z or ±HH:MM, or a local YYYY-MM-DDTHH:mm[:ss] with timezone (an IANA name). A local time that a daylight-saving change skips is refused with the first valid time; one that happens twice uses disambiguation (default earlier). A one-off action messages a chat you can write to (message_session) or starts new work as a conversation (start_session); a recurring schedule always starts new work, needs a name unique in the project, and runs cron on the clock of timezone (default UTC). Success means SAM accepted the schedule, not that anything ran: check it with sam_schedule_get. Reuse requestKey to retry without a duplicate.',
  kind: 'write',
  input: ScheduleCreateInput,
  run: createSchedule,
});

export const samScheduleUpdate = defineOperation({
  name: 'sam_schedule_update',
  title: 'Change a schedule',
  description:
    'Use this to move, pause or resume a schedule. One-off: give runAt (with timezone, disambiguation or expiresAt as needed) and expectedVersion from sam_schedule_get; only a pending schedule can move, and a one-off schedule cannot be paused. Recurring: paused true or false pauses or resumes it, and cron or timezone changes when it runs. A schedule SAM disabled must be reviewed in SAM. Reuse requestKey on retries.',
  kind: 'write',
  input: ScheduleUpdateInput,
  run: updateSchedule,
});

export const samScheduleCancel = defineOperation({
  name: 'sam_schedule_cancel',
  title: 'Cancel a one-off schedule',
  description:
    "Use this to cancel a one-off schedule before it runs. It cannot be undone; confirm with the user. Needs expectedVersion from sam_schedule_get. If the action was already admitted, cancelling cannot take it back (actionAlreadyAdmitted): stop the started work with sam_work_stop. Recurring schedules are paused with sam_schedule_update, or deleted in SAM's Automation page. Reuse requestKey on retries.",
  kind: 'destructive',
  input: ScheduleCancelInput,
  run: cancelSchedule,
});

export const scheduleOperations = [
  samSchedulesList,
  samScheduleGet,
  samScheduleCreate,
  samScheduleUpdate,
  samScheduleCancel,
] as const;
