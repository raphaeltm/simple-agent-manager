import type { Env } from '../env';
import { listRealSuperadmins, notifySuperadminsThrottled } from './superadmin-ops-alerts';

export const DEFAULT_CRON_FAILURE_NOTIFICATION_THROTTLE_MS = 60 * 60_000;
export const DEFAULT_CRON_FAILURE_NOTIFICATION_KV_PREFIX = 'cron-failure-notification';

function resolveThrottleMs(env: Env): number {
  const parsed = Number.parseInt(env.CRON_FAILURE_NOTIFICATION_THROTTLE_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CRON_FAILURE_NOTIFICATION_THROTTLE_MS;
}

function throttleKey(env: Env, sweepName: string): string {
  const prefix = env.CRON_FAILURE_NOTIFICATION_KV_PREFIX ??
    DEFAULT_CRON_FAILURE_NOTIFICATION_KV_PREFIX;
  return `${prefix}:${sweepName}`;
}

/**
 * Notify real superadmins once per failed sweep per throttle window. Delivery semantics (stamp
 * after a durable create, retry a failed delivery next tick) live in `notifySuperadminsThrottled`.
 */
export async function notifyFailedSweeps(
  env: Env,
  failedSweeps: string[],
): Promise<{ notifiedSweeps: number; notificationsSent: number }> {
  if (failedSweeps.length === 0) return { notifiedSweeps: 0, notificationsSent: 0 };

  const recipients = await listRealSuperadmins(env);
  const throttleMs = resolveThrottleMs(env);
  let notifiedSweeps = 0;
  let notificationsSent = 0;
  for (const sweepName of [...new Set(failedSweeps)]) {
    const result = await notifySuperadminsThrottled(
      env,
      {
        throttleKey: throttleKey(env, sweepName),
        throttleMs,
        notification: {
          type: 'cron_failure',
          urgency: 'high',
          title: `Operational sweep failed: ${sweepName}`,
          body: 'A scheduled recovery sweep failed. Review Workers logs and runtime controls.',
          actionUrl: '/admin/logs',
          metadata: { sweepName },
        },
      },
      recipients
    );
    if (result.sent > 0) notifiedSweeps++;
    notificationsSent += result.sent;
  }
  return { notifiedSweeps, notificationsSent };
}
