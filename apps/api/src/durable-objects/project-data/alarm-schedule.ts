/**
 * Shared ProjectData alarm scheduling.
 *
 * Keep every path that reschedules the Durable Object alarm on the same
 * candidate set. Lifecycle checks are coupled: heartbeat updates must not hide
 * task reconciliation or workspace idle deadlines.
 */
import * as acpSessions from './acp-sessions';
import * as attention from './attention';
import * as idleCleanup from './idle-cleanup';
import * as mailbox from './mailbox';
import * as reconciliation from './reconciliation';
import type { Env } from './types';

export function computeProjectDataAlarmTime(sql: SqlStorage, env: Env): number | null {
  const { idleCleanupTime, workspaceIdleCheckTime } = idleCleanup.computeIdleAlarmTimes(sql);
  const heartbeatTime = acpSessions.computeHeartbeatAlarmTime(sql, env);
  const pollIntervalMs = Number.parseInt(env.MAILBOX_DELIVERY_POLL_INTERVAL_MS ?? '30000', 10);
  const mailboxTime = mailbox.computeMailboxAlarmTime(sql, pollIntervalMs);
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
