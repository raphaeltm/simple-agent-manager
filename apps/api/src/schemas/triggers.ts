import * as v from 'valibot';

const TriggerSourceTypeSchema = v.picklist(['cron', 'webhook', 'github']);
const TriggerStatusSchema = v.picklist(['active', 'paused', 'disabled']);
const TaskModeSchema = v.picklist(['task', 'conversation']);
const VMSizeSchema = v.picklist(['small', 'medium', 'large']);

export const CreateTriggerSchema = v.object({
  name: v.string(),
  description: v.optional(v.string()),
  sourceType: TriggerSourceTypeSchema,
  cronExpression: v.optional(v.string()),
  cronTimezone: v.optional(v.string()),
  skipIfRunning: v.optional(v.boolean()),
  promptTemplate: v.string(),
  agentProfileId: v.optional(v.string()),
  taskMode: v.optional(TaskModeSchema),
  vmSizeOverride: v.optional(VMSizeSchema),
  maxConcurrent: v.optional(v.number()),
});

export const UpdateTriggerSchema = v.object({
  name: v.optional(v.string()),
  description: v.optional(v.nullable(v.string())),
  status: v.optional(TriggerStatusSchema),
  cronExpression: v.optional(v.string()),
  cronTimezone: v.optional(v.string()),
  skipIfRunning: v.optional(v.boolean()),
  promptTemplate: v.optional(v.string()),
  agentProfileId: v.optional(v.nullable(v.string())),
  taskMode: v.optional(TaskModeSchema),
  vmSizeOverride: v.optional(v.nullable(VMSizeSchema)),
  maxConcurrent: v.optional(v.number()),
});
