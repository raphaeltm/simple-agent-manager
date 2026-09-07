import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { sendNotificationOnce } from '../services/notification';

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

/** Notify real superadmins once per failed sweep/throttle window. */
export async function notifyFailedSweeps(
  env: Env,
  failedSweeps: string[],
): Promise<{ notifiedSweeps: number; notificationsSent: number }> {
  if (failedSweeps.length === 0) return { notifiedSweeps: 0, notificationsSent: 0 };

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

  let notifiedSweeps = 0;
  let notificationsSent = 0;
  const throttleMs = resolveThrottleMs(env);
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
    const deliveries = await Promise.allSettled(
      (superadmins.results ?? []).map((user) =>
        sendNotificationOnce(
          env,
          user.id,
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
        )
      ),
    );
    notificationsSent += deliveries.filter(
      (delivery) => delivery.status === 'fulfilled' && delivery.value
    ).length;
    const failedDeliveries = deliveries.length -
      deliveries.filter((delivery) => delivery.status === 'fulfilled').length;
    if (failedDeliveries > 0) {
      log.error('cron.failed_sweep_notification_delivery_failed', {
        sweepName,
        failedDeliveries,
      });
    }
  }

  return { notifiedSweeps, notificationsSent };
}
