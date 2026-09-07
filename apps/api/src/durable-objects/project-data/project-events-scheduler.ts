import { resolveProjectEventLimits } from './project-events-limits';
import type { ProjectEventOrphanScanCursor } from './project-events-orphan-retention';
import type { Env } from './types';

export type ProjectEventSchedulerPhase = 'materialization' | 'retention';

export type ProjectEventSchedulerState = {
  nextAttemptAt: number | null;
  nextRetentionAt: number | null;
};

export function isProjectEventWakeEnabled(env: Env): boolean {
  const raw = env.PROJECT_EVENT_WAKE_ENABLED;
  if (raw === undefined || raw.trim() === '') return true;
  return raw === 'true';
}

export function readSchedulerState(sql: SqlStorage, projectId: string): ProjectEventSchedulerState {
  const row = sql
    .exec(
      `SELECT next_attempt_at, next_retention_at
       FROM project_event_wake_scheduler_state
       WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
  return {
    nextAttemptAt: typeof row?.next_attempt_at === 'number' ? row.next_attempt_at : null,
    nextRetentionAt: typeof row?.next_retention_at === 'number' ? row.next_retention_at : null,
  };
}

export function computeProjectEventMaterializationAlarmTime(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): number | null {
  if (!projectId || !isProjectEventWakeEnabled(env)) return null;
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readSchedulerState(sql, projectId);
  if (checkpoint.nextAttemptAt !== null) {
    return checkpoint.nextAttemptAt <= now ? now : checkpoint.nextAttemptAt;
  }
  const row = sql
    .exec(
      `SELECT MIN(
                CASE
                  WHEN s.delivery_cooldown_until IS NOT NULL AND s.delivery_cooldown_until > ?
                  THEN s.delivery_cooldown_until
                  ELSE s.wake_due_at
                END
              ) AS due_at
       FROM project_event_subscriptions s
       JOIN chat_sessions c ON c.id = s.target_session_id
       WHERE s.project_id = ?
         AND s.contract_version >= 2
         AND s.owner_version >= 2
         AND s.owner_type = 'agent'
         AND s.owner_project_id = s.project_id
         AND s.owner_chat_session_id = s.target_session_id
         AND s.owner_task_id IS NOT NULL
         AND s.lifecycle_state = 'active'
         AND (s.expires_at IS NULL OR s.expires_at > ?)
         AND (s.delivery_lifetime_expires_at IS NULL OR s.delivery_lifetime_expires_at > ?)
         AND s.prompt_delivery_count < ?
         AND s.requested_delivery = 'existing_session_prompt'
         AND s.resolved_delivery = 'queued_for_prompt_delivery'
         AND s.target_session_id IS NOT NULL
         AND s.wake_due_at IS NOT NULL
         AND c.status IN ('active', 'sleeping')`,
      now,
      projectId,
      now,
      now,
      limits.wakeMaxPerSubscription
    )
    .toArray()[0];
  const dueAt = typeof row?.due_at === 'number' ? row.due_at : null;
  if (dueAt === null) return null;
  return dueAt <= now ? now + limits.wakeMaterializationMinAlarmDelayMs : dueAt;
}

export function computeProjectEventRetentionAlarmTime(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): number | null {
  if (!projectId) return null;
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readSchedulerState(sql, projectId);
  if (checkpoint.nextRetentionAt !== null) {
    return checkpoint.nextRetentionAt <= now ? now : checkpoint.nextRetentionAt;
  }
  const row = sql
    .exec(
      `SELECT MIN(received_at) AS oldest_at
       FROM project_events
       WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
  if (typeof row?.oldest_at !== 'number') return null;
  const nextRetentionAt = now + limits.retentionMinAlarmDelayMs;
  persistRetentionCheckpoint(sql, projectId, nextRetentionAt, now);
  return nextRetentionAt;
}

export function isProjectEventRetentionDue(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): boolean {
  if (!projectId) return false;
  const checkpoint = readSchedulerState(sql, projectId);
  if (checkpoint.nextRetentionAt !== null) return checkpoint.nextRetentionAt <= now;
  return computeProjectEventRetentionAlarmTime(sql, env, projectId, now) === now;
}

export function ensureProjectEventRetentionScheduled(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  now: number
): void {
  const limits = resolveProjectEventLimits(env);
  persistRetentionCheckpoint(sql, projectId, now + limits.retentionIntervalMs, now, true);
}

export function markSchedulerSuccess(
  sql: SqlStorage,
  projectId: string,
  now: number,
  phase: ProjectEventSchedulerPhase,
  nextAt: number | null = null,
  orphanCursor?: ProjectEventOrphanScanCursor | null
): void {
  const materialization = phase === 'materialization';
  sql.exec(
    `INSERT INTO project_event_wake_scheduler_state
     (project_id, next_attempt_at, next_retention_at, materialization_failures, retention_failures,
      last_materialization_succeeded_at, last_retention_succeeded_at,
      last_materialization_error_code, last_retention_error_code,
      last_materialization_failed_at, last_retention_failed_at, updated_at,
      orphan_scan_lifecycle_at, orphan_scan_match_id)
     VALUES (?, ?, ?, 0, 0, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       next_attempt_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_attempt_at END,
       next_retention_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_retention_at END,
       materialization_failures = CASE WHEN ? THEN 0 ELSE project_event_wake_scheduler_state.materialization_failures END,
       retention_failures = CASE WHEN ? THEN 0 ELSE project_event_wake_scheduler_state.retention_failures END,
       last_materialization_succeeded_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_materialization_succeeded_at END,
       last_retention_succeeded_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_retention_succeeded_at END,
       last_materialization_error_code = CASE WHEN ? THEN NULL ELSE project_event_wake_scheduler_state.last_materialization_error_code END,
       last_retention_error_code = CASE WHEN ? THEN NULL ELSE project_event_wake_scheduler_state.last_retention_error_code END,
       last_materialization_failed_at = CASE WHEN ? THEN NULL ELSE project_event_wake_scheduler_state.last_materialization_failed_at END,
       last_retention_failed_at = CASE WHEN ? THEN NULL ELSE project_event_wake_scheduler_state.last_retention_failed_at END,
       orphan_scan_lifecycle_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.orphan_scan_lifecycle_at END,
       orphan_scan_match_id = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.orphan_scan_match_id END,
       updated_at = ?`,
    projectId,
    materialization ? nextAt : null,
    materialization ? null : nextAt,
    materialization ? now : null,
    materialization ? null : now,
    now,
    orphanCursor?.lifecycleAt ?? null,
    orphanCursor?.matchId ?? null,
    materialization ? 1 : 0,
    nextAt,
    materialization ? 0 : 1,
    nextAt,
    materialization ? 1 : 0,
    materialization ? 0 : 1,
    materialization ? 1 : 0,
    now,
    materialization ? 0 : 1,
    now,
    materialization ? 1 : 0,
    materialization ? 0 : 1,
    materialization ? 1 : 0,
    materialization ? 0 : 1,
    orphanCursor !== undefined ? 1 : 0,
    orphanCursor?.lifecycleAt ?? null,
    orphanCursor !== undefined ? 1 : 0,
    orphanCursor?.matchId ?? null,
    now
  );
}

export function recordSchedulerFailure(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  phase: ProjectEventSchedulerPhase,
  error: unknown,
  now = Date.now()
): void {
  if (!projectId) return;
  const limits = resolveProjectEventLimits(env);
  const materialization = phase === 'materialization';
  const code = error instanceof Error ? error.name : 'Error';
  const current = sql
    .exec(
      `SELECT materialization_failures, retention_failures
       FROM project_event_wake_scheduler_state
       WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
  const currentFailures = materialization
    ? typeof current?.materialization_failures === 'number'
      ? current.materialization_failures
      : 0
    : typeof current?.retention_failures === 'number'
      ? current.retention_failures
      : 0;
  const exponent = Math.min(currentFailures, 10);
  const backoff = Math.min(
    limits.wakeMaterializationBackoffMaxMs,
    limits.wakeMaterializationBackoffBaseMs * 2 ** exponent
  );
  sql.exec(
    `INSERT INTO project_event_wake_scheduler_state
     (project_id, next_attempt_at, next_retention_at, materialization_failures, retention_failures,
      last_materialization_error_code, last_retention_error_code,
      last_materialization_failed_at, last_retention_failed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       next_attempt_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_attempt_at END,
       next_retention_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_retention_at END,
       materialization_failures = CASE WHEN ? THEN project_event_wake_scheduler_state.materialization_failures + 1 ELSE project_event_wake_scheduler_state.materialization_failures END,
       retention_failures = CASE WHEN ? THEN project_event_wake_scheduler_state.retention_failures + 1 ELSE project_event_wake_scheduler_state.retention_failures END,
       last_materialization_error_code = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_materialization_error_code END,
       last_retention_error_code = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_retention_error_code END,
       last_materialization_failed_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_materialization_failed_at END,
       last_retention_failed_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_retention_failed_at END,
       updated_at = ?`,
    projectId,
    materialization ? now + backoff : null,
    materialization ? null : now + backoff,
    materialization ? 1 : 0,
    materialization ? 0 : 1,
    materialization ? code : null,
    materialization ? null : code,
    materialization ? now : null,
    materialization ? null : now,
    now,
    materialization ? 1 : 0,
    now + backoff,
    materialization ? 0 : 1,
    now + backoff,
    materialization ? 1 : 0,
    materialization ? 0 : 1,
    materialization ? 1 : 0,
    code,
    materialization ? 0 : 1,
    code,
    materialization ? 1 : 0,
    now,
    materialization ? 0 : 1,
    now,
    now
  );
}

function persistRetentionCheckpoint(
  sql: SqlStorage,
  projectId: string,
  nextRetentionAt: number,
  now: number,
  preserveExisting = false
): void {
  sql.exec(
    `INSERT INTO project_event_wake_scheduler_state
     (project_id, next_retention_at, materialization_failures, retention_failures, updated_at)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       next_retention_at = CASE WHEN ? = 1
         THEN COALESCE(project_event_wake_scheduler_state.next_retention_at, ?)
         ELSE ? END,
       updated_at = ?`,
    projectId,
    nextRetentionAt,
    now,
    preserveExisting ? 1 : 0,
    nextRetentionAt,
    nextRetentionAt,
    now
  );
}
