/**
 * In-app and Web Push notifications to the installation's operators (real superadmins) for
 * operational failures that no user action surfaces: a scheduled sweep that throws, or a
 * ProjectData archive circuit breaker that a sweep opened.
 */
import type { CreateNotificationRequest } from '@simple-agent-manager/shared';
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { sendNotificationOnce } from '../services/notification';

export const DEFAULT_CRON_FAILURE_NOTIFICATION_THROTTLE_MS = 60 * 60_000;

/**
 * How long an operator notification's dedupe claim is held (`CRON_FAILURE_NOTIFICATION_THROTTLE_MS`).
 * For failed sweeps it is also the per-sweep throttle window.
 */
export function resolveOperatorNotificationThrottleMs(env: Env): number {
  const parsed = Number.parseInt(env.CRON_FAILURE_NOTIFICATION_THROTTLE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CRON_FAILURE_NOTIFICATION_THROTTLE_MS;
}

/** Active superadmins. The anonymous-trial sentinel and `system` rows are never operators. */
export async function listOperatorUserIds(env: Env): Promise<string[]> {
  const sentinelId = env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
  const superadmins = await env.DATABASE.prepare(
    `SELECT id FROM users
     WHERE role = 'superadmin'
       AND status = 'active'
       AND status != 'system'
       AND id != ?`
  )
    .bind(sentinelId)
    .all<{ id: string }>();
  return (superadmins.results ?? []).map((user) => user.id);
}

/**
 * Send `notification` to each operator at most once per `dedupKey` until `expiresAt` (a per-user
 * Durable Object claim). One failed delivery does not stop the others. Returns how many
 * notifications were created and how many deliveries failed; callers log failures under their
 * own event names.
 */
export async function notifyOperatorsOnce(
  env: Env,
  operatorIds: readonly string[],
  dedupKey: string,
  expiresAt: number,
  notification: CreateNotificationRequest,
  now: number = Date.now()
): Promise<{ sent: number; failed: number }> {
  const deliveries = await Promise.allSettled(
    operatorIds.map((userId) =>
      sendNotificationOnce(env, userId, dedupKey, expiresAt, notification, now)
    )
  );
  return {
    sent: deliveries.filter((delivery) => delivery.status === 'fulfilled' && delivery.value).length,
    failed: deliveries.filter((delivery) => delivery.status === 'rejected').length,
  };
}
