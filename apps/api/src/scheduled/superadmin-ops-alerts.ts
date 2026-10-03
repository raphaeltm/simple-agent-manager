import { type CreateNotificationRequest, TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { sendNotification } from '../services/notification';

export interface SuperadminOpsAlert {
  /** Stable identity of the alert episode; one notification per recipient per window. */
  throttleKey: string;
  throttleMs: number;
  notification: CreateNotificationRequest;
}

export interface SuperadminOpsAlertResult {
  recipients: number;
  sent: number;
  throttled: number;
  failed: number;
}

/** Real superadmins only: never the trial sentinel or system users. */
export async function listRealSuperadmins(env: Env): Promise<string[]> {
  const sentinelId = env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
  const rows = await env.DATABASE.prepare(
    `SELECT id FROM users
     WHERE role = 'superadmin'
       AND status = 'active'
       AND status != 'system'
       AND id != ?`
  )
    .bind(sentinelId)
    .all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

/**
 * Push one operational alert to each real superadmin, at most once per recipient per window.
 *
 * Delivery is the authority, not the throttle. A recipient's KV stamp is written only AFTER
 * their notification was durably created, so a failed delivery is retried on the next tick
 * instead of being suppressed for the whole window (claiming a throttle or dedup key first
 * and then failing to create the notification hid the alert it existed to send). The price is
 * a possible duplicate when two ticks overlap or KV lags, which is acceptable for operator
 * alerts. A KV read failure still fails closed for that recipient, so a broken KV cannot turn
 * a five-minute cron into a notification flood.
 */
export async function notifySuperadminsThrottled(
  env: Env,
  alert: SuperadminOpsAlert,
  recipients: readonly string[]
): Promise<SuperadminOpsAlertResult> {
  const result: SuperadminOpsAlertResult = {
    recipients: recipients.length,
    sent: 0,
    throttled: 0,
    failed: 0,
  };
  const expirationTtl = Math.max(60, Math.ceil(alert.throttleMs / 1_000));
  for (const userId of recipients) {
    const key = `${alert.throttleKey}:${userId}`;
    try {
      if (await env.KV.get(key)) {
        result.throttled++;
        continue;
      }
    } catch (error) {
      result.failed++;
      log.error('ops_alert.throttle_read_failed', {
        throttleKey: alert.throttleKey,
        userId,
        action: 'skipped_recipient_fail_closed',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    try {
      await sendNotification(env, userId, alert.notification);
    } catch (error) {
      result.failed++;
      log.error('ops_alert.delivery_failed', {
        throttleKey: alert.throttleKey,
        userId,
        action: 'retry_next_tick',
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.sent++;
    await env.KV.put(key, new Date().toISOString(), { expirationTtl }).catch((error) => {
      log.error('ops_alert.throttle_write_failed', {
        throttleKey: alert.throttleKey,
        userId,
        action: 'may_repeat_next_tick',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return result;
}
