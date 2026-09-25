import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { transitionTaskToTerminal } from '../../services/task-terminal-transition';
import type { NotificationService } from '../notification';
import * as activity from './activity';
import * as attention from './attention';
import { isAcpSessionMidTurn, loadLatestActiveAcpActivity } from './latest-acp-activity';
import { readProjectEventWakeLeaseUntil } from './project-events-wake-delivery';
import { activeWorkHardStallMs, reconciliationDeadlineMs } from './reconciliation-thresholds';
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
      if (marker.kind === 'reconciliation_checkin') {
        if (deferEventWakeReconciliationCheckin(sql, env, marker)) {
          continue;
        }
        if (deferActiveReconciliationCheckin(sql, env, marker)) {
          continue;
        }
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

function deferEventWakeReconciliationCheckin(
  sql: SqlStorage,
  env: Env,
  marker: ExpiredAttentionMarker
): boolean {
  const now = Date.now();
  const leaseUntil = readProjectEventWakeLeaseUntil(sql, marker.sessionId, now);
  if (leaseUntil === null) return false;
  const extendedExpiry = Math.min(leaseUntil, now + reconciliationDeadlineMs(env));
  if (extendedExpiry <= now) return false;
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
      reason: 'project_event_wake_lease',
      leaseUntil,
      extendedExpiry,
    })
  );
  log.info('attention_marker.reconciliation_checkin_deferred_for_project_event_wake', {
    markerId: marker.id,
    sessionId: marker.sessionId,
    taskId: marker.taskId,
    workspaceId: marker.workspaceId,
    leaseUntil,
    extendedExpiry,
  });
  return true;
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

  const projectId = hooks.projectId ?? null;
  const source = `project_data.attention_expiry.${marker.kind}`;
  const transitionOutcome = await transitionTaskToTerminal(env as unknown as WorkerEnv, {
    taskId: marker.taskId,
    projectId,
    status: 'failed',
    reason: errorMessage,
    source,
    expectedWorkspaceId: marker.workspaceId,
    expectedChatSessionId: marker.sessionId,
    // Work preservation (or, failing that, cleanupTaskRun) owns the runtime.
    // Pre-marking it `stopped` would skip the real VM stop and make the
    // workspace unsleepable ("Workspace cannot sleep from status stopped").
    stopWorkspace: false,
  });
  if (transitionOutcome !== 'transitioned' || !projectId) {
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

  // Most expiries hit a conversation that already slept while it waited: keep it
  // asleep and wakeable instead of failing the session (idea 01M1XGHX7NQZQYWQRV5C1PJ60N).
  // A check-in that expires on an agent still mid-turn is the watchdog's verdict
  // that the turn will not end: a sleep would wait on it, and every capture would
  // race its minute-by-minute re-report. That runtime is released now, as before.
  const workerEnv = env as unknown as WorkerEnv;
  const preservationService = await import('../../services/failed-task-preservation');
  const unresponsiveMidTurn =
    marker.kind === 'reconciliation_checkin' &&
    isAcpSessionMidTurn(loadLatestActiveAcpActivity(sql, marker));
  const preservation = unresponsiveMidTurn
    ? ({ outcome: 'not_preservable', gap: 'agent_unresponsive' } as const)
    : await preservationService.preserveFailedTaskWork(workerEnv, {
        taskId: marker.taskId,
        projectId,
        workspaceId: marker.workspaceId,
        chatSessionId: marker.sessionId,
        source,
      });
  if (preservationService.withholdsFailedTaskTeardown(preservation)) {
    log.info('attention_marker.expired_work_preserved', {
      markerId: marker.id,
      sessionId: marker.sessionId,
      taskId: marker.taskId,
      kind: marker.kind,
      outcome: preservation.outcome,
    });
    return;
  }

  await preservationService.surfaceFailedTaskWorkLoss(workerEnv, {
    taskId: marker.taskId,
    projectId,
    chatSessionId: marker.sessionId,
    reason: preservation.gap,
    source,
  });
  await failSession(marker.sessionId, errorMessage);
  hooks.scheduleSummarySync?.();
  // Off the alarm's critical path (`.claude/rules/47`). The object stays alive
  // while this I/O is pending (`ctx.waitUntil` has no effect in a Durable Object),
  // and should it never finish, the node-cleanup reapers still take the runtime:
  // `sleepLifecycleOwnsTerminalTaskWorkspaceSql` releases every failed workspace
  // the sleep lifecycle neither holds nor can claim.
  if (marker.workspaceId) {
    void cleanupExpiredTaskRun(env, marker.workspaceId, marker.taskId);
  }

  log.info('attention_marker.expired_cleanup', {
    markerId: marker.id,
    sessionId: marker.sessionId,
    taskId: marker.taskId,
    workspaceId: marker.workspaceId,
    kind: marker.kind,
  });
}

async function cleanupExpiredTaskRun(env: Env, workspaceId: string, taskId: string): Promise<void> {
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

function toPositiveNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function maxFreshEvidence(floor: number, ...values: unknown[]): number | null {
  const freshValues = values
    .map((value) => toFreshNumber(value, floor))
    .filter((value): value is number => value !== null);
  return freshValues.length > 0 ? Math.max(...freshValues) : null;
}

interface ActiveCheckinEvidence {
  evidenceAt: number;
  extendedExpiry: number;
  evidenceKinds: string[];
  promptCeilingAt: number | null;
  runtimeWorkCeilingAt: number | null;
}

function activeCheckinEvidence(
  env: Env,
  marker: ExpiredAttentionMarker,
  active: Record<string, unknown>,
  now: number
): ActiveCheckinEvidence | null {
  const hardStallMs = activeWorkHardStallMs(env);
  const deadlineMs = reconciliationDeadlineMs(env);
  const activityName = typeof active.activity === 'string' ? active.activity : null;
  const runtimeWorkState =
    typeof active.runtime_work_state === 'string' ? active.runtime_work_state : null;
  const evidenceKinds: string[] = [];
  const ceilings: number[] = [];
  let evidenceAt = 0;
  let promptCeilingAt: number | null = null;
  let runtimeWorkCeilingAt: number | null = null;

  if (activityName === 'prompting' || activityName === 'recovering') {
    const activityEvidenceAt = maxFreshEvidence(
      marker.createdAt,
      active.prompt_started_at,
      active.activity_at
    );
    const promptAnchor =
      toPositiveNumber(active.prompt_started_at) ??
      toPositiveNumber(active.activity_at) ??
      activityEvidenceAt;

    if (activityEvidenceAt !== null && promptAnchor !== null) {
      promptCeilingAt = promptAnchor + hardStallMs;
      if (promptCeilingAt > now) {
        evidenceAt = Math.max(evidenceAt, activityEvidenceAt);
        ceilings.push(promptCeilingAt);
        evidenceKinds.push('prompt_activity');
      }
    }
  }

  if (runtimeWorkState === 'active' || runtimeWorkState === 'settling') {
    const runtimeWorkEvidenceAt = maxFreshEvidence(
      marker.createdAt,
      active.runtime_work_progress_at,
      active.runtime_work_updated_at
    );
    const runtimeWorkAnchor =
      toPositiveNumber(active.runtime_work_progress_at) ??
      toPositiveNumber(active.runtime_work_updated_at) ??
      runtimeWorkEvidenceAt;

    if (runtimeWorkEvidenceAt !== null && runtimeWorkAnchor !== null) {
      runtimeWorkCeilingAt = runtimeWorkAnchor + hardStallMs;
      if (runtimeWorkCeilingAt > now) {
        evidenceAt = Math.max(evidenceAt, runtimeWorkEvidenceAt);
        ceilings.push(runtimeWorkCeilingAt);
        evidenceKinds.push('runtime_work');
      }
    }
  }

  if (evidenceAt <= 0 || ceilings.length === 0) return null;
  return {
    evidenceAt,
    extendedExpiry: Math.min(now + deadlineMs, ...ceilings),
    evidenceKinds,
    promptCeilingAt,
    runtimeWorkCeilingAt,
  };
}

function deferActiveReconciliationCheckin(
  sql: SqlStorage,
  env: Env,
  marker: ExpiredAttentionMarker
): boolean {
  const active = loadLatestActiveAcpActivity(sql, marker);
  if (!active) return false;

  const activityName = typeof active.activity === 'string' ? active.activity : null;
  const runtimeWorkState =
    typeof active.runtime_work_state === 'string' ? active.runtime_work_state : null;
  const now = Date.now();
  const evidence = activeCheckinEvidence(env, marker, active, now);
  if (!evidence) return false;

  attention.extendAttentionExpiry(sql, marker.id, evidence.extendedExpiry);
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
      evidenceKinds: evidence.evidenceKinds,
      acpSessionId: active.acp_session_id,
      activity: activityName,
      runtimeWorkState,
      evidenceAt: evidence.evidenceAt,
      extendedExpiry: evidence.extendedExpiry,
      activeWorkHardStallMs: activeWorkHardStallMs(env),
      promptCeilingAt: evidence.promptCeilingAt,
      runtimeWorkCeilingAt: evidence.runtimeWorkCeilingAt,
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
    evidenceKinds: evidence.evidenceKinds,
    evidenceAt: evidence.evidenceAt,
    extendedExpiry: evidence.extendedExpiry,
    activeWorkHardStallMs: activeWorkHardStallMs(env),
    promptCeilingAt: evidence.promptCeilingAt,
    runtimeWorkCeilingAt: evidence.runtimeWorkCeilingAt,
  });
  return true;
}
