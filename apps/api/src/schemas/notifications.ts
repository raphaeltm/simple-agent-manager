import { NOTIFICATION_CHANNELS, NOTIFICATION_TYPES } from '@simple-agent-manager/shared';
import * as v from 'valibot';

// Derive validation schemas from the shared notification constants so the API
// contract cannot drift from the canonical type/channel lists.
const NotificationTypeSchema = v.picklist(NOTIFICATION_TYPES);

const NotificationChannelSchema = v.picklist(NOTIFICATION_CHANNELS);

export const UpdateNotificationPreferenceSchema = v.object({
  notificationType: v.union([NotificationTypeSchema, v.literal('*')]),
  projectId: v.optional(v.nullable(v.string())),
  channel: NotificationChannelSchema,
  enabled: v.boolean(),
});
