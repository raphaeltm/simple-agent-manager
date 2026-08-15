import { createModuleLogger } from '../../lib/logger';
import type { NotificationService } from '../notification';
import * as activity from './activity';
import * as attention from './attention';
import * as idleCleanup from './idle-cleanup';
import type { Env } from './types';

const log = createModuleLogger('project_data.attention_expiry');

export async function processExpiredAttentionMarkers(
  sql: SqlStorage,
  env: Env,
  failSession: (sessionId: string, errorMessage: string) => Promise<void>
): Promise<void> {
  const expiredMarkers = attention.getExpiredMarkers(sql).sort((left, right) => {
    const leftPriority = left.kind === 'reconciliation_checkin' ? 0 : 1;
    const rightPriority = right.kind === 'reconciliation_checkin' ? 0 : 1;
    return leftPriority - rightPriority;
  });
  for (const marker of expiredMarkers) {
    try {
      if (marker.kind === 'needs_input') {
        await processExpiredNeedsInputMarker(sql, env, marker, failSession);
        continue;
      }
      attention.resolveAttentionMarkerById(sql, marker.id, 'system', 'expired');
      await failExpiredTaskMarker(sql, env, marker, failSession);
    } catch (err) {
      log.error('attention_marker.expiry_processing_failed', {
        markerId: marker.id,
        sessionId: marker.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await processDueNeedsInputEscalations(sql, env);
}

async function processDueNeedsInputEscalations(sql: SqlStorage, env: Env): Promise<void> {
  for (const marker of attention.getDueAttentionEscalations(sql)) {
    try {
      attention.advanceAttentionEscalation(sql, marker, env.HUMAN_INPUT_ESCALATION_FRACTIONS);
      activity.recordActivityEventInternal(
        sql,
        'attention.escalated',
        'system',
        null,
        marker.workspaceId,
        marker.sessionId,
        marker.taskId,
        JSON.stringify({
          markerId: marker.id,
          escalationCount: marker.escalationCount + 1,
        })
      );
      await resendNeedsInputPush(env, marker);
    } catch (err) {
      log.warn('attention_marker.escalation_processing_failed', {
        markerId: marker.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function processExpiredNeedsInputMarker(
  sql: SqlStorage,
  env: Env,
  marker: ReturnType<typeof attention.getExpiredMarkers>[number],
  failSession: (sessionId: string, errorMessage: string) => Promise<void>
): Promise<void> {
  const now = Date.now();
  const maxExpiresAt =
    marker.maxExpiresAt ??
    marker.createdAt + attention.humanInputMaxWaitMs(env.HUMAN_INPUT_MAX_WAIT_MS);
  const confirmedDelivery = await hasConfirmedPushDelivery(env, marker);

  if (!confirmedDelivery && now < maxExpiresAt) {
    const extendedExpiry = Math.min(
      maxExpiresAt,
      now + attention.humanInputUndeliveredGraceMs(env.HUMAN_INPUT_UNDELIVERED_GRACE_MS)
    );
    if (extendedExpiry > now) {
      attention.extendAttentionExpiry(sql, marker.id, extendedExpiry);
      activity.recordActivityEventInternal(
        sql,
        'attention.expiry_deferred',
        'system',
        null,
        marker.workspaceId,
        marker.sessionId,
        marker.taskId,
        JSON.stringify({ markerId: marker.id, extendedExpiry, maxExpiresAt })
      );
      await resendNeedsInputPush(env, marker);
      log.warn('attention_marker.expiry_deferred_without_delivery', {
        markerId: marker.id,
        sessionId: marker.sessionId,
        taskId: marker.taskId,
        extendedExpiry,
        maxExpiresAt,
      });
      return;
    }
  }

  const reason = confirmedDelivery ? 'expired' : 'hard_max_expired';
  attention.resolveAttentionMarkerById(sql, marker.id, 'system', reason);
  await failExpiredTaskMarker(sql, env, marker, failSession);
}

function notificationStub(env: Env, userId: string): DurableObjectStub<NotificationService> | null {
  if (!env.NOTIFICATION) return null;
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

async function hasConfirmedPushDelivery(
  env: Env,
  marker: ReturnType<typeof attention.getExpiredMarkers>[number]
): Promise<boolean> {
  if (!marker.notificationUserId || !marker.sourceNotificationId) return false;
  try {
    return (
      (await notificationStub(env, marker.notificationUserId)?.hasConfirmedPushDelivery(
        marker.notificationUserId,
        marker.sourceNotificationId
      )) ?? false
    );
  } catch (err) {
    log.warn('attention_marker.delivery_receipt_check_failed', {
      markerId: marker.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

async function resendNeedsInputPush(
  env: Env,
  marker: ReturnType<typeof attention.getExpiredMarkers>[number]
): Promise<void> {
  if (!marker.notificationUserId || !marker.sourceNotificationId) return;
  try {
    await notificationStub(env, marker.notificationUserId)?.resendPushNotification(
      marker.notificationUserId,
      marker.sourceNotificationId
    );
  } catch (err) {
    log.warn('attention_marker.push_escalation_failed', {
      markerId: marker.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function failExpiredTaskMarker(
  sql: SqlStorage,
  env: Env,
  marker: ReturnType<typeof attention.getExpiredMarkers>[number],
  failSession: (sessionId: string, errorMessage: string) => Promise<void>
): Promise<void> {
  if ((marker.kind !== 'needs_input' && marker.kind !== 'reconciliation_checkin') || !marker.taskId)
    return;

  const errorMessage =
    marker.kind === 'reconciliation_checkin'
      ? 'Agent became unresponsive after SAM check-in'
      : 'Human input request expired after timeout';

  await failTaskAndWorkspace(env, marker.taskId, marker.workspaceId, errorMessage);
  await failSession(marker.sessionId, errorMessage);
  activity.recordActivityEventInternal(
    sql,
    'attention.expired',
    'system',
    null,
    marker.workspaceId,
    marker.sessionId,
    marker.taskId,
    JSON.stringify({ kind: marker.kind, markerId: marker.id })
  );

  if (marker.kind === 'reconciliation_checkin' && marker.workspaceId) {
    void cleanupUnresponsiveTaskRun(env, marker.workspaceId, marker.taskId);
  }

  log.info('attention_marker.expired_cleanup', {
    markerId: marker.id,
    sessionId: marker.sessionId,
    taskId: marker.taskId,
    workspaceId: marker.workspaceId,
    kind: marker.kind,
  });
}

async function failTaskAndWorkspace(
  env: Env,
  taskId: string,
  workspaceId: string | null,
  errorMessage: string
): Promise<void> {
  if (!env.DATABASE) return;
  await env.DATABASE.prepare(
    `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`
  )
    .bind(errorMessage, taskId)
    .run();
  if (workspaceId) await idleCleanup.stopWorkspaceInD1(env.DATABASE, workspaceId);
}

async function cleanupUnresponsiveTaskRun(
  env: Env,
  workspaceId: string,
  taskId: string
): Promise<void> {
  try {
    const workerEnv = env as unknown as import('../../env').Env;
    const { cleanupTaskRun } = await import('../../services/task-runner');
    await cleanupTaskRun(taskId, workerEnv);
  } catch (err) {
    log.error('reconciliation.cleanup_task_run_failed', {
      workspaceId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
