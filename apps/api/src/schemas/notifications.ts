import * as v from 'valibot';

const NotificationTypeSchema = v.picklist([
  'task_complete', 'needs_input', 'error', 'progress', 'session_ended', 'pr_created',
]);

const NotificationChannelSchema = v.picklist(['in_app']);

export const UpdateNotificationPreferenceSchema = v.object({
  notificationType: v.union([NotificationTypeSchema, v.literal('*')]),
  projectId: v.optional(v.nullable(v.string())),
  channel: NotificationChannelSchema,
  enabled: v.boolean(),
});
