import {
  MAX_WEB_PUSH_ENDPOINT_LENGTH,
  MAX_WEB_PUSH_SUBSCRIPTION_KEY_LENGTH,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_TYPES,
} from '@simple-agent-manager/shared';
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

const HttpsWebPushEndpointSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_WEB_PUSH_ENDPOINT_LENGTH),
  v.check((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'endpoint must be an HTTPS URL without credentials')
);

const SubscriptionKeySchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(MAX_WEB_PUSH_SUBSCRIPTION_KEY_LENGTH),
  v.regex(/^[A-Za-z0-9_-]+$/, 'subscription keys must use unpadded base64url')
);

export const WebPushSubscriptionSchema = v.object({
  endpoint: HttpsWebPushEndpointSchema,
  expirationTime: v.optional(v.nullable(v.pipe(v.number(), v.integer(), v.minValue(0)))),
  keys: v.object({
    p256dh: SubscriptionKeySchema,
    auth: SubscriptionKeySchema,
  }),
});

export const DeleteWebPushSubscriptionSchema = v.object({
  endpoint: HttpsWebPushEndpointSchema,
});
