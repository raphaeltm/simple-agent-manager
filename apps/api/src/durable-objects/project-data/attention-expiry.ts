import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { transitionTaskToTerminal } from '../../services/task-terminal-transition';
import type { NotificationService } from '../notification';
import * as activity from './activity';
import * as attention from './attention';
import { reconciliationDeadlineMs } from './reconciliation-thresholds';
import type { Env } from './types';

const log = createModuleLogger('project_data.attention_expiry');

type ExpiredAttentionMarker = ReturnType<typeof attention.getExpiredMarkers>[number];

export interface AttentionExpiryProcessingHooks {
  projectId?: string | null;
  scheduleSummarySync?: () => void;
}

export async function processExpiredAttentionMarkers(
  sql: SqlStorage,
  env: Env,
  failSession: (sessionId: string, errorMessage: string) => Promise<void>,
  hooks: AttentionExpiryProcessingHooks = {}
): Promise<void> {
  const expiredMarkers = attention.getExpiredMarkers(sql).sort((left, right) => {
    const leftPriority = left.kind === 'reconciliation_checkin' ? 0 : 1;
    const rightPriority = right.kind === 'reconciliation_checkin' ? 0 : 1;
    return leftPriority - rightPriority;
  });
  for (const marker of expiredMarkers) {
    try {
      if (marker.kind === 'needs_input') {
        await processExpiredNeedsInputMarker(sql, env, marker, failSession, hooks);
        continue;
      }
      if (
        marker.kind === 'reconciliation_checkin' &&
        deferActiveReconciliationCheckin(sql, env, marker)
      ) {
        continue;
      }
      attention.resolveAttentionMarkerById(sql, marker.id, 'system', 'expired');
      await failExpiredTaskMarker(sql, env, marker, failSession, hooks);
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
  marker: ExpiredAttentionMarker,
  failSession: (sessionId: string, errorMessage: string) => Promise<void>,
  hooks: AttentionExpiryProcessingHooks
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
  await failExpiredTaskMarker(sql, env, marker, failSession, hooks);
}

function notificationStub(env: Env, userId: string): DurableObjectStub<NotificationService> | null {
  if (!env.NOTIFICATION) return null;
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

async function hasConfirmedPushDelivery(
  env: Env,
  marker: ExpiredAttentionMarker
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

async function resendNeedsInputPush(env: Env, marker: ExpiredAttentionMarker): Promise<void> {
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
  marker: ExpiredAttentionMarker,
  failSession: (sessionId: string, errorMessage: string) => Promise<void>,
  hooks: AttentionExpiryProcessingHooks
): Promise<void> {
  if ((marker.kind !== 'needs_input' && marker.kind !== 'reconciliation_checkin') || !marker.taskId)
    return;

  const errorMessage =
    marker.kind === 'reconciliation_checkin'
      ? 'Agent became unresponsive after SAM check-in'
      : 'Human input request expired after timeout';

  const transitionOutcome = await transitionTaskToTerminal(env as unknown as WorkerEnv, {
    taskId: marker.taskId,
    projectId: hooks.projectId ?? null,
    status: 'failed',
    reason: errorMessage,
    source: `project_data.attention_expiry.${marker.kind}`,
    expectedWorkspaceId: marker.workspaceId,
    expectedChatSessionId: marker.sessionId,
    stopWorkspace: true,
  });
  if (transitionOutcome !== 'transitioned') {
    log.warn('attention_marker.task_terminal_transition_skipped', {
      markerId: marker.id,
      sessionId: marker.sessionId,
      taskId: marker.taskId,
      workspaceId: marker.workspaceId,
      kind: marker.kind,
      transitionOutcome,
    });
    return;
  }

  await failSession(marker.sessionId, errorMessage);
  hooks.scheduleSummarySync?.();
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

function toFreshNumber(value: unknown, floor: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= floor ? value : null;
}

function maxFreshEvidence(floor: number, ...values: unknown[]): number | null {
  const freshValues = values
    .map((value) => toFreshNumber(value, floor))
    .filter((value): value is number => value !== null);
  return freshValues.length > 0 ? Math.max(...freshValues) : null;
}

function deferActiveReconciliationCheckin(
  sql: SqlStorage,
  env: Env,
  marker: ExpiredAttentionMarker
): boolean {
  const activeRows = sql
    .exec(
      `SELECT acp.id AS acp_session_id,
              acp.status AS acp_status,
              ss.activity AS activity,
              ss.activity_at AS activity_at,
              ss.prompt_started_at AS prompt_started_at,
              ss.runtime_work_state AS runtime_work_state,
              ss.runtime_work_updated_at AS runtime_work_updated_at,
              ss.runtime_work_progress_at AS runtime_work_progress_at
       FROM acp_sessions acp
       LEFT JOIN session_state ss ON ss.session_id = acp.id
       WHERE acp.chat_session_id = ?
         AND acp.status IN ('assigned', 'running')
         AND (? IS NULL OR acp.workspace_id = ?)
       ORDER BY COALESCE(acp.started_at, acp.assigned_at, acp.updated_at, acp.created_at) DESC
       LIMIT 1`,
      marker.sessionId,
      marker.workspaceId,
      marker.workspaceId
    )
    .toArray();
  const active = activeRows[0];
  if (!active) return false;

  const activityName = typeof active.activity === 'string' ? active.activity : null;
  const runtimeWorkState =
    typeof active.runtime_work_state === 'string' ? active.runtime_work_state : null;
  const activityEvidenceAt =
    activityName === 'prompting' || activityName === 'recovering'
      ? maxFreshEvidence(marker.createdAt, active.prompt_started_at, active.activity_at)
      : null;
  const runtimeWorkEvidenceAt =
    runtimeWorkState === 'active' || runtimeWorkState === 'settling'
      ? maxFreshEvidence(
          marker.createdAt,
          active.runtime_work_progress_at,
          active.runtime_work_updated_at
        )
      : null;
  const evidenceAt = Math.max(activityEvidenceAt ?? 0, runtimeWorkEvidenceAt ?? 0);
  if (evidenceAt <= 0) return false;

  const extendedExpiry = Date.now() + reconciliationDeadlineMs(env);
  attention.extendAttentionExpiry(sql, marker.id, extendedExpiry);
  activity.recordActivityEventInternal(
    sql,
    'attention.expiry_deferred',
    'system',
    null,
    marker.workspaceId,
    marker.sessionId,
    marker.taskId,
    JSON.stringify({
      markerId: marker.id,
      kind: marker.kind,
      reason: 'current_generation_activity',
      acpSessionId: active.acp_session_id,
      activity: activityName,
      runtimeWorkState,
      evidenceAt,
      extendedExpiry,
    })
  );
  log.info('attention_marker.reconciliation_checkin_deferred_for_active_acp_work', {
    markerId: marker.id,
    sessionId: marker.sessionId,
    taskId: marker.taskId,
    workspaceId: marker.workspaceId,
    acpSessionId: active.acp_session_id,
    activity: activityName,
    runtimeWorkState,
    evidenceAt,
    extendedExpiry,
  });
  return true;
}
