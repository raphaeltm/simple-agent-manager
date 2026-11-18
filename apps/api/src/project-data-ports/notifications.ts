import type { NotificationsPort } from '@simple-agent-manager/project-data';

import type { NotificationService } from '../durable-objects/notification';
import type { ProjectDataEnv } from '../durable-objects/project-data/types';

function notificationStub(
  env: ProjectDataEnv,
  userId: string
): DurableObjectStub<NotificationService> | null {
  if (!env.NOTIFICATION) return null;
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

/** Push delivery receipts and escalation through the per-user Notification object. */
export const notificationsPort: NotificationsPort = {
  async hasConfirmedPushDelivery(env, userId, notificationId) {
    const stub = notificationStub(env, userId);
    return (await stub?.hasConfirmedPushDelivery(userId, notificationId)) ?? false;
  },
  async resendPush(env, userId, notificationId) {
    await notificationStub(env, userId)?.resendPushNotification(userId, notificationId);
  },
};
