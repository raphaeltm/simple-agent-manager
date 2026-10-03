import {
  type CreateNotificationRequest,
  TRIAL_ANONYMOUS_USER_ID,
} from '@simple-agent-manager/shared';

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
 * Live throttle stamps under `prefix`, read with one `KV.list` call per 1,000-key page instead of one `get`
 * per alert and recipient, so a caller can skip throttled alerts before spending its delivery
 * budget. Returns null when the stamps cannot all be read (a failed or still-incomplete list):
 * the caller must then send nothing, so a broken KV cannot turn a cron into a flood.
 */
export async function listLiveThrottleStamps(
  env: Env,
  prefix: string,
  now: number,
  maxPages: number
): Promise<Set<string> | null> {
  const live = new Set<string>();
  let cursor: string | undefined;
  try {
    for (let page = 0; page < maxPages; page++) {
      const result = await env.KV.list({ prefix: `${prefix}:`, ...(cursor ? { cursor } : {}) });
      for (const key of result.keys) {
        // `expiration` is in seconds; a key KV has not purged yet must not count once expired.
        if (key.expiration === undefined || key.expiration * 1_000 > now) live.add(key.name);
      }
      if (result.list_complete) return live;
      cursor = result.cursor;
    }
  } catch (error) {
    log.error('ops_alert.throttle_list_failed', {
      prefix,
      action: 'send_nothing_fail_closed',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
  log.error('ops_alert.throttle_list_truncated', {
    prefix,
    maxPages,
    action: 'send_nothing_fail_closed',
  });
  return null;
}

/**
 * Deliver one operational alert to `recipients`, stamping each recipient's throttle key only
 * AFTER their notification was durably created.
 *
 * Delivery is the authority, not the throttle: a failed delivery is retried on the next tick
 * instead of being suppressed for the whole window (claiming a throttle or dedup key first and
 * then failing to create the notification hid the alert it existed to send). The price is a
 * possible duplicate when two ticks overlap or KV lags, which is acceptable for operator alerts.
 */
export async function deliverOpsAlert(
  env: Env,
  alert: SuperadminOpsAlert,
  recipients: readonly string[]
): Promise<Pick<SuperadminOpsAlertResult, 'sent' | 'failed'>> {
  const result = { sent: 0, failed: 0 };
  const expirationTtl = Math.max(60, Math.ceil(alert.throttleMs / 1_000));
  for (const userId of recipients) {
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
    await env.KV.put(`${alert.throttleKey}:${userId}`, new Date().toISOString(), {
      expirationTtl,
    }).catch((error) => {
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

/**
 * Push one operational alert to each real superadmin, at most once per recipient per window,
 * checking each recipient's throttle stamp with a `get` first. A KV read failure fails closed
 * for that recipient. Delivery and stamping follow `deliverOpsAlert`.
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
  const due: string[] = [];
  for (const userId of recipients) {
    try {
      if (await env.KV.get(`${alert.throttleKey}:${userId}`)) {
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
    due.push(userId);
  }
  const delivered = await deliverOpsAlert(env, alert, due);
  result.sent += delivered.sent;
  result.failed += delivered.failed;
  return result;
}
