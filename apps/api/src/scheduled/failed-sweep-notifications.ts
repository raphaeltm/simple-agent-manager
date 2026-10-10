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

interface SweepNotificationContext {
  operatorIds: readonly string[];
  dedupExpiresAt: number;
  expirationTtl: number;
  now: number;
}

/** Claim one sweep's KV throttle, then notify every operator; returns notifications sent. */
async function notifyFailedSweepOnce(
  env: Env,
  sweepName: string,
  context: SweepNotificationContext
): Promise<{ notified: boolean; sent: number }> {
  const key = throttleKey(env, sweepName);
  try {
    if (await env.KV.get(key)) return { notified: false, sent: 0 };
    await env.KV.put(key, new Date().toISOString(), { expirationTtl: context.expirationTtl });
  } catch (err) {
    // Fail closed for notification delivery: without a working throttle we
    // cannot uphold the no-spam guarantee. cron.completed still emits below.
    log.error('cron.failed_sweep_notification_throttle_failed', {
      sweepName,
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return { notified: false, sent: 0 };
  }

  const delivery = await notifyOperatorsOnce(
    env,
    context.operatorIds,
    key,
    context.dedupExpiresAt,
    {
      type: 'cron_failure',
      urgency: 'high',
      title: `Operational sweep failed: ${sweepName}`,
      body: 'A scheduled recovery sweep failed. Review Workers logs and runtime controls.',
      actionUrl: '/admin/logs',
      metadata: { sweepName },
    },
    context.now
  );
  if (delivery.failed > 0) {
    log.error('cron.failed_sweep_notification_delivery_failed', {
      sweepName,
      failedDeliveries: delivery.failed,
    });
  }
  return { notified: true, sent: delivery.sent };
}

/** Notify real superadmins once per failed sweep/throttle window. */
export async function notifyFailedSweeps(
  env: Env,
  failedSweeps: string[]
): Promise<{ notifiedSweeps: number; notificationsSent: number }> {
  if (failedSweeps.length === 0) return { notifiedSweeps: 0, notificationsSent: 0 };

  const throttleMs = resolveOperatorNotificationThrottleMs(env);
  const now = Date.now();
  const context: SweepNotificationContext = {
    operatorIds: await listOperatorUserIds(env),
    dedupExpiresAt: now + throttleMs,
    expirationTtl: Math.max(60, Math.ceil(throttleMs / 1_000)),
    now,
  };
  // Each sweep name has its own throttle key and dedup claim, so they are independent.
  const results = await Promise.all(
    [...new Set(failedSweeps)].map((sweepName) => notifyFailedSweepOnce(env, sweepName, context))
  );
  return {
    notifiedSweeps: results.filter((result) => result.notified).length,
    notificationsSent: results.reduce((total, result) => total + result.sent, 0),
  };
}
