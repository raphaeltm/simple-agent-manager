import { resolveProjectEventLimits } from './project-events-limits';
import type { Env } from './types';

export function readProjectEventWakeSchedulerState(
  sql: SqlStorage,
  projectId: string
): { nextAttemptAt: number | null; nextRetentionAt: number | null } {
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

export function computeProjectEventRetentionAlarmTime(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  now = Date.now()
): number | null {
  if (!projectId) return null;
  const limits = resolveProjectEventLimits(env);
  const checkpoint = readProjectEventWakeSchedulerState(sql, projectId);
  if (checkpoint.nextRetentionAt !== null) {
    return Math.max(checkpoint.nextRetentionAt, now + limits.retentionMinAlarmDelayMs);
  }
  const row = sql
    .exec(
      `SELECT MIN(received_at) AS oldest_at
       FROM project_events
       WHERE project_id = ?`,
      projectId
    )
    .toArray()[0];
  return typeof row?.oldest_at === 'number' ? now + limits.retentionIntervalMs : null;
}

export function isProjectEventRetentionDue(
  sql: SqlStorage,
  _env: Env,
  projectId: string | null,
  now = Date.now()
): boolean {
  if (!projectId) return false;
  const checkpoint = readProjectEventWakeSchedulerState(sql, projectId);
  if (checkpoint.nextRetentionAt !== null) return checkpoint.nextRetentionAt <= now;
  return false;
}

export function ensureProjectEventRetentionScheduled(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  now: number
): void {
  const limits = resolveProjectEventLimits(env);
  sql.exec(
    `INSERT INTO project_event_wake_scheduler_state
     (project_id, next_retention_at, materialization_failures, retention_failures, updated_at)
     VALUES (?, ?, 0, 0, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       next_retention_at = COALESCE(project_event_wake_scheduler_state.next_retention_at, ?),
       updated_at = ?`,
    projectId,
    now + limits.retentionIntervalMs,
    now,
    now + limits.retentionIntervalMs,
    now
  );
}

export function markSchedulerSuccess(
  sql: SqlStorage,
  projectId: string,
  now: number,
  phase: 'materialization' | 'retention',
  nextAt: number | null = null
): void {
  const materialization = phase === 'materialization';
  sql.exec(
    `INSERT INTO project_event_wake_scheduler_state
     (project_id, next_attempt_at, next_retention_at, materialization_failures, retention_failures,
      last_materialization_succeeded_at, last_retention_succeeded_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       next_attempt_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_attempt_at END,
       next_retention_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.next_retention_at END,
       materialization_failures = CASE WHEN ? THEN 0 ELSE project_event_wake_scheduler_state.materialization_failures END,
       retention_failures = CASE WHEN ? THEN 0 ELSE project_event_wake_scheduler_state.retention_failures END,
       last_materialization_succeeded_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_materialization_succeeded_at END,
       last_retention_succeeded_at = CASE WHEN ? THEN ? ELSE project_event_wake_scheduler_state.last_retention_succeeded_at END,
       updated_at = ?`,
    projectId,
    materialization ? nextAt : null,
    materialization ? null : nextAt,
    0,
    0,
    materialization ? now : null,
    materialization ? null : now,
    now,
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
    now
  );
}

export function recordSchedulerFailure(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  phase: 'materialization' | 'retention',
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

export function deferNextMaterialization(
  sql: SqlStorage,
  projectId: string,
  nextAt: number,
  now: number
): void {
  markSchedulerSuccess(sql, projectId, now, 'materialization', nextAt);
}
