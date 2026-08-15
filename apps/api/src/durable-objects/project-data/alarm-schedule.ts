/**
 * Shared ProjectData alarm scheduling.
 *
 * Keep every path that reschedules the Durable Object alarm on the same
 * candidate set. Lifecycle checks are coupled: heartbeat updates must not hide
 * task reconciliation or workspace idle deadlines.
 */
import { createModuleLogger } from '../../lib/logger';
import * as acpSessions from './acp-sessions';
import * as attention from './attention';
import { resolveDurableExecutionConfig } from './durable-execution-config';
import * as idleCleanup from './idle-cleanup';
import * as mailbox from './mailbox';
import { computePromptDeliveryAlarmTime } from './prompt-delivery';
import * as reconciliation from './reconciliation';
import type { Env } from './types';

const log = createModuleLogger('project_data.alarm_schedule');

export function computeProjectDataAlarmTime(sql: SqlStorage, env: Env): number | null {
  const { idleCleanupTime, workspaceIdleCheckTime } = idleCleanup.computeIdleAlarmTimes(sql);
  const heartbeatTime = acpSessions.computeHeartbeatAlarmTime(sql, env);
  const pollIntervalMs = Number.parseInt(env.MAILBOX_DELIVERY_POLL_INTERVAL_MS ?? '30000', 10);
  const legacyMailboxTime = mailbox.computeMailboxAlarmTime(sql, pollIntervalMs);
  let mailboxTime = legacyMailboxTime;
  try {
    const deliveryConfig = resolveDurableExecutionConfig(env);
    if (deliveryConfig.deliveryEnabled) {
      const durableDeliveryTime = computePromptDeliveryAlarmTime(sql, deliveryConfig);
      mailboxTime = durableDeliveryTime === null
        ? legacyMailboxTime
        : legacyMailboxTime === null
          ? durableDeliveryTime
          : Math.min(durableDeliveryTime, legacyMailboxTime);
    }
  } catch (error) {
    // Invalid durability configuration fails the new delivery engine closed,
    // while preserving unrelated ProjectData lifecycle alarms.
    log.error('durable_delivery_config_invalid', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const attentionTime = attention.computeAttentionAlarmTime(sql);
  const reconciliationTime = reconciliation.computeReconciliationAlarmTime(sql, env);

  const candidates = [
    idleCleanupTime,
    workspaceIdleCheckTime,
    heartbeatTime,
    mailboxTime,
    attentionTime,
    reconciliationTime,
  ].filter((time): time is number => time !== null);

  return candidates.length > 0 ? Math.min(...candidates) : null;
}
