/**
 * Session snapshot anomaly classes for `ops_find_anomalies`: failed sleeps, captures and
 * wakes in the lookback window, and wakes that have stayed `waking` too long.
 */
import { isLiveWakeTaskStatus } from '../session-snapshot-recovery-conditions';
import {
  type AnomalyClassResult,
  int,
  isoMinus,
  minutesSince,
  result,
  type Row,
  type SweepContext,
  text,
} from './anomaly-shared';

export async function snapshotFailures(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT s.id, s.project_id, s.chat_session_id, s.workspace_id, s.node_id, s.user_id,
            s.status, s.sleep_status, s.recovery_status, s.restore_status,
            s.sleep_attempts, s.recovery_attempts,
            (s.capture_error IS NOT NULL) AS has_capture_error,
            (s.sleep_error IS NOT NULL) AS has_sleep_error,
            (s.recovery_error IS NOT NULL) AS has_recovery_error,
            s.updated_at, COUNT(*) OVER () AS total
     FROM session_snapshots s
     WHERE julianday(s.updated_at) >= julianday(?)
       AND (s.sleep_status IN ('failed', 'terminal_failed')
            OR s.recovery_status = 'failed'
            OR s.restore_status = 'failed'
            OR s.status = 'failed'
            OR s.capture_error IS NOT NULL)
     ORDER BY julianday(s.updated_at) DESC, s.id ASC
     LIMIT ?`
  )
    .bind(isoMinus(ctx.now, ctx.settings.lookbackHours * 3_600_000), ctx.cap)
    .all<Row>();
  return result('session_snapshot_failure', rows.results ?? [], (row) => {
    const parts = [
      `status ${text(row.status)}`,
      `sleep ${text(row.sleep_status) ?? 'none'} (${int(row.sleep_attempts)} attempts)`,
      `recovery ${text(row.recovery_status) ?? 'none'} (${int(row.recovery_attempts)} attempts)`,
      `restore ${text(row.restore_status) ?? 'none'}`,
    ];
    const errors = [
      int(row.has_capture_error) ? 'capture_error' : null,
      int(row.has_sleep_error) ? 'sleep_error' : null,
      int(row.has_recovery_error) ? 'recovery_error' : null,
    ].filter(Boolean);
    return {
      ids: {
        snapshotId: text(row.id),
        chatSessionId: text(row.chat_session_id),
        projectId: text(row.project_id),
        workspaceId: text(row.workspace_id),
        nodeId: text(row.node_id),
        userId: text(row.user_id),
      },
      reason:
        `Session snapshot failed: ${parts.join(', ')}` +
        (errors.length ? `; recorded ${errors.join(', ')} (read with ops_get_session_story)` : '') +
        '.',
      observedAt: text(row.updated_at),
    };
  });
}

/**
 * Wakes still `waking` past `operations.opsAnomalyWakingMinutes`, oldest first, with no
 * lookback bound: a stuck wake can be weeks old, and that is what this class is for. Age
 * counts from the claim (`recovery_claimed_at`), which a renewal moves forward. A row whose
 * recovery task is no longer waking is a dead claim that `dead_wake_claim_reconciliation`
 * ends once the claim lease passes. A live task means a slow wake (for example a
 * provider-limit wait).
 */
export async function stalledWakes(ctx: SweepContext): Promise<AnomalyClassResult> {
  const rows = await ctx.env.DATABASE.prepare(
    `SELECT s.id, s.project_id, s.chat_session_id, s.workspace_id, s.user_id, s.runtime,
            s.recovery_task_id, s.recovery_attempts,
            COALESCE(s.recovery_claimed_at, s.updated_at) AS waking_since,
            t.status AS task_status, t.execution_step, t.admission_state,
            COUNT(*) OVER () AS total
     FROM session_snapshots s
     LEFT JOIN tasks t ON t.id = s.recovery_task_id
     WHERE s.recovery_status = 'waking'
       AND julianday(COALESCE(s.recovery_claimed_at, s.updated_at)) < julianday(?)
     ORDER BY julianday(COALESCE(s.recovery_claimed_at, s.updated_at)) ASC, s.id ASC
     LIMIT ?`
  )
    .bind(isoMinus(ctx.now, ctx.settings.wakingMinutes * 60_000), ctx.cap)
    .all<Row>();
  return result('session_wake_stalled', rows.results ?? [], (row) => {
    const since = text(row.waking_since);
    const taskStatus = text(row.task_status);
    const task = taskStatus
      ? `recovery task ${taskStatus} (step ${text(row.execution_step) ?? 'none'}, admission ` +
        `${text(row.admission_state) ?? 'none'})`
      : 'recovery task missing';
    const verdict =
      taskStatus && isLiveWakeTaskStatus(taskStatus)
        ? 'The wake is still running; read the task with ops_get_session_story.'
        : 'The wake is over but its claim was never ended (dead claim).';
    return {
      ids: {
        snapshotId: text(row.id),
        chatSessionId: text(row.chat_session_id),
        projectId: text(row.project_id),
        workspaceId: text(row.workspace_id),
        taskId: text(row.recovery_task_id),
        userId: text(row.user_id),
      },
      reason:
        `${text(row.runtime) ?? 'unknown'} session has been waking for ` +
        `${minutesSince(since, ctx.now) ?? '?'} min (${int(row.recovery_attempts)} attempts); ` +
        `${task}. ${verdict}`,
      observedAt: since,
    };
  });
}
