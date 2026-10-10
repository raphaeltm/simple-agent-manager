import type { Env } from '../env';
import { log } from '../lib/logger';
import {
  listOperatorUserIds,
  notifyOperatorsOnce,
  resolveOperatorNotificationThrottleMs,
} from './operator-notifications';

export const DEFAULT_CRON_FAILURE_NOTIFICATION_KV_PREFIX = 'cron-failure-notification';

function throttleKey(env: Env, sweepName: string): string {
  const prefix =
    env.CRON_FAILURE_NOTIFICATION_KV_PREFIX ?? DEFAULT_CRON_FAILURE_NOTIFICATION_KV_PREFIX;
  return `${prefix}:${sweepName}`;
}

/** Notify real superadmins once per failed sweep/throttle window. */
export async function notifyFailedSweeps(
  env: Env,
  failedSweeps: string[]
): Promise<{ notifiedSweeps: number; notificationsSent: number }> {
  if (failedSweeps.length === 0) return { notifiedSweeps: 0, notificationsSent: 0 };

  const operatorIds = await listOperatorUserIds(env);

  let notifiedSweeps = 0;
  let notificationsSent = 0;
  const throttleMs = resolveOperatorNotificationThrottleMs(env);
  const now = Date.now();
  const dedupExpiresAt = now + throttleMs;
  const expirationTtl = Math.max(60, Math.ceil(throttleMs / 1_000));

  for (const sweepName of [...new Set(failedSweeps)]) {
    const key = throttleKey(env, sweepName);
    try {
      if (await env.KV.get(key)) continue;
      await env.KV.put(key, new Date().toISOString(), { expirationTtl });
    } catch (err) {
      // Fail closed for notification delivery: without a working throttle we
      // cannot uphold the no-spam guarantee. cron.completed still emits below.
      log.error('cron.failed_sweep_notification_throttle_failed', {
        sweepName,
        key,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    notifiedSweeps++;
    const delivery = await notifyOperatorsOnce(
      env,
      operatorIds,
      key,
      dedupExpiresAt,
      {
        type: 'cron_failure',
        urgency: 'high',
        title: `Operational sweep failed: ${sweepName}`,
        body: 'A scheduled recovery sweep failed. Review Workers logs and runtime controls.',
        actionUrl: '/admin/logs',
        metadata: { sweepName },
      },
      now
    );
    notificationsSent += delivery.sent;
    if (delivery.failed > 0) {
      log.error('cron.failed_sweep_notification_delivery_failed', {
        sweepName,
        failedDeliveries: delivery.failed,
      });
    }
  }

  return { notifiedSweeps, notificationsSent };
}
