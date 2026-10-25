/** The inputs of the Connector's schedule writes, shared by the operations and the write logic. */
import * as v from 'valibot';

const id = v.pipe(v.string(), v.minLength(1));
const text = v.pipe(v.string(), v.minLength(1));
// minValue before integer: the Connector's JSON Schema converter rejects the other order.
const version = v.pipe(v.number(), v.minValue(1), v.integer());
const requestKey = v.optional(v.pipe(v.string(), v.regex(/^[A-Za-z0-9._:-]{1,128}$/)));
const timing = {
  timezone: v.optional(text),
  disambiguation: v.optional(v.picklist(['earlier', 'later'])),
  expiresAt: v.optional(text),
};

export const ScheduleCreateInput = v.object({
  projectId: id,
  requestKey,
  runAt: v.optional(text),
  cron: v.optional(text),
  ...timing,
  name: v.optional(text),
  reason: v.optional(text),
  action: v.variant('kind', [
    v.object({ kind: v.literal('message_session'), sessionId: id, message: text }),
    v.object({
      kind: v.literal('start_session'),
      prompt: text,
      agentProfileId: v.optional(id),
      skillId: v.optional(id),
      taskMode: v.optional(v.picklist(['conversation', 'task'])),
    }),
  ]),
});
export const ScheduleUpdateInput = v.object({
  projectId: id,
  scheduleId: id,
  requestKey,
  expectedVersion: v.optional(version),
  runAt: v.optional(text),
  ...timing,
  paused: v.optional(v.boolean()),
  cron: v.optional(text),
});
export const ScheduleCancelInput = v.object({
  projectId: id,
  scheduleId: id,
  expectedVersion: version,
  reason: v.optional(text),
  requestKey,
});
export type ScheduleCreate = v.InferOutput<typeof ScheduleCreateInput>;
export type ScheduleUpdate = v.InferOutput<typeof ScheduleUpdateInput>;
export type ScheduleCancel = v.InferOutput<typeof ScheduleCancelInput>;

const StartsWork = v.object({ kind: v.literal('start_session') });

/** Whether a sam_schedule_create request schedules new agent work, which every recurring
 * schedule and every one-off start_session does. Lets the Connector apply its start budget. */
export function scheduleCreateStartsWork(input: Record<string, unknown>): boolean {
  return input.cron !== undefined || v.is(StartsWork, input.action);
}
