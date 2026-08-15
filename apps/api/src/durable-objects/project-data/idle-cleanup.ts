/**
 * Idle cleanup scheduling and workspace idle timeout management.
 */
import {
  DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_IDLE_CLEANUP_MAX_RESIDENCE_MS,
  DEFAULT_IDLE_CLEANUP_MAX_RETRIES,
  DEFAULT_IDLE_CLEANUP_RETRY_DELAY_MS,
  DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES,
  DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { recordActivityEventInternal } from './activity';
import { createAttentionMarker } from './attention';
import {
  listReporterScopedTaskCandidates,
  terminalizeIdleTaskInD1,
} from './idle-cleanup-terminalization';
import { materializeSession } from './materialization';
import { persistSystemMessage } from './messages';
import {
  parseCleanupAt,
  parseIdleCleanupSchedule,
  parseMinEarliest,
  parseWorkspaceActivity,
} from './row-schemas';
import { upsertActivityState } from './session-state';
import { stopSessionInternal } from './sessions';
import type { Env } from './types';

export { deleteWorkspaceInD1, stopWorkspaceInD1 } from './idle-cleanup-workspace';

const log = createModuleLogger('idle_cleanup');
const IDLE_CLEANUP_ATTENTION_KIND = 'idle_cleanup_failed';
const IDLE_CLEANUP_RETRY_EXHAUSTED_MESSAGE =
  'Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.';
const IDLE_CLEANUP_MAX_RESIDENCE_MESSAGE =
  'Idle cleanup could not complete within its maximum residence time. Your work has been preserved — please check the workspace manually.';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type IdleCleanupEntry = ReturnType<typeof parseIdleCleanupSchedule>;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function maxResidenceExceeded(entry: IdleCleanupEntry, now: number, maxResidenceMs: number): boolean {
  return now - entry.createdAt >= maxResidenceMs;
}

function markIdleCleanupAttentionRequired(
  sql: SqlStorage,
  entry: IdleCleanupEntry,
  terminalState: string,
  reason: string,
  message: string,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void
): void {
  const now = Date.now();
  let attentionMarkerId = entry.attentionMarkerId;
  if (!attentionMarkerId) {
    try {
      attentionMarkerId = createAttentionMarker(sql, {
        sessionId: entry.sessionId,
        taskId: entry.taskId,
        workspaceId: entry.workspaceId,
        kind: IDLE_CLEANUP_ATTENTION_KIND,
        source: 'idle_cleanup',
        reason,
        metadata: JSON.stringify({ terminalState }),
      }).id;
    } catch (err) {
      log.error('attention_marker_create_failed', {
        sessionId: entry.sessionId,
        workspaceId: entry.workspaceId,
        taskId: entry.taskId,
        terminalState,
        ...serializeError(err),
      });
    }
  }

  const shouldNotify = entry.failureNotifiedAt === null;
  let messageId: string | null = null;
  let messageCreatedAt: number | null = null;
  let messageSequence: number | null = null;
  if (shouldNotify) {
    const msgResult = persistSystemMessage(sql, entry.sessionId, message);
    if (msgResult) {
      messageId = msgResult.id;
      messageCreatedAt = msgResult.now;
      messageSequence = msgResult.sequence;
    }
  }

  sql.exec(
    `UPDATE idle_cleanup_schedule
     SET terminal_state = ?,
         terminal_reason = ?,
         terminal_at = ?,
         cleanup_at = ?,
         last_error = ?,
         failure_notified_at = COALESCE(failure_notified_at, ?),
         attention_marker_id = COALESCE(attention_marker_id, ?)
     WHERE session_id = ? AND terminal_state IS NULL`,
    terminalState,
    reason,
    now,
    now,
    reason,
    shouldNotify ? now : null,
    attentionMarkerId,
    entry.sessionId
  );

  recordActivityEventInternal(
    sql,
    'session.idle_cleanup_attention_required',
    'system',
    null,
    entry.workspaceId,
    entry.sessionId,
    entry.taskId,
    JSON.stringify({
      terminalState,
      reason,
      retryCount: entry.retryCount,
      attentionMarkerId,
      notified: messageId !== null,
    })
  );

  broadcastEvent(
    'session.idle_cleanup_attention_required',
    {
      sessionId: entry.sessionId,
      workspaceId: entry.workspaceId,
      taskId: entry.taskId,
      terminalState,
      reason,
      attentionMarkerId,
      notified: messageId !== null,
    },
    entry.sessionId
  );

  if (messageId && messageCreatedAt !== null && messageSequence !== null) {
    broadcastEvent(
      'message.new',
      {
        sessionId: entry.sessionId,
        messageId,
        role: 'system',
        content: message,
        toolMetadata: null,
        createdAt: messageCreatedAt,
        sequence: messageSequence,
      },
      entry.sessionId
    );
  }
}

export function scheduleIdleCleanup(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  workspaceId: string,
  taskId: string | null
): { cleanupAt: number } {
  const timeoutMinutes = positiveInt(
    env.SESSION_IDLE_TIMEOUT_MINUTES,
    DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES
  );
  const cleanupAt = Date.now() + timeoutMinutes * 60 * 1000;

  sql.exec(
    `INSERT OR REPLACE INTO idle_cleanup_schedule (session_id, workspace_id, task_id, cleanup_at, created_at, retry_count)
     VALUES (?, ?, ?, ?, ?, 0)`,
    sessionId,
    workspaceId,
    taskId,
    cleanupAt,
    Date.now()
  );

  return { cleanupAt };
}

export function cancelIdleCleanup(sql: SqlStorage, sessionId: string): void {
  sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);
}

export function resetIdleCleanup(
  sql: SqlStorage,
  env: Env,
  sessionId: string
): { cleanupAt: number } {
  const timeoutMinutes = positiveInt(
    env.SESSION_IDLE_TIMEOUT_MINUTES,
    DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES
  );
  const cleanupAt = Date.now() + timeoutMinutes * 60 * 1000;

  const existing = sql
    .exec(
      'SELECT session_id FROM idle_cleanup_schedule WHERE session_id = ? AND terminal_state IS NULL',
      sessionId
    )
    .toArray();

  if (existing.length === 0) {
    return { cleanupAt: 0 };
  }

  sql.exec(
    `UPDATE idle_cleanup_schedule
     SET cleanup_at = ?, retry_count = 0, last_error = NULL
     WHERE session_id = ? AND terminal_state IS NULL`,
    cleanupAt,
    sessionId
  );

  return { cleanupAt };
}

export function getCleanupAt(sql: SqlStorage, sessionId: string): number | null {
  const row = sql
    .exec(
      'SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id = ? AND terminal_state IS NULL',
      sessionId
    )
    .toArray()[0];
  return row ? parseCleanupAt(row, 'idle_cleanup.get_cleanup_at') : null;
}

/**
 * Process expired idle cleanup rows. Returns list of processed entries for broadcasting.
 */
export async function processExpiredCleanups(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  stopWorkspaceInD1: (workspaceId: string, projectId: string) => Promise<void>,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  scheduleSummarySync: () => void
): Promise<void> {
  const now = Date.now();
  const maxRetries = positiveInt(env.IDLE_CLEANUP_MAX_RETRIES, DEFAULT_IDLE_CLEANUP_MAX_RETRIES);
  const maxResidenceMs = positiveInt(
    env.IDLE_CLEANUP_MAX_RESIDENCE_MS,
    DEFAULT_IDLE_CLEANUP_MAX_RESIDENCE_MS
  );
  const retryDelay = positiveInt(
    env.IDLE_CLEANUP_RETRY_DELAY_MS,
    DEFAULT_IDLE_CLEANUP_RETRY_DELAY_MS
  );
  const timeoutMs =
    positiveInt(env.SESSION_IDLE_TIMEOUT_MINUTES, DEFAULT_SESSION_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
  const candidateLimit = positiveInt(
    env.IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP
  );

  const expired = sql
    .exec(
      `SELECT session_id, workspace_id, task_id, cleanup_at, created_at, retry_count,
              terminal_state, terminal_reason, terminal_at, last_error,
              failure_notified_at, attention_marker_id
       FROM idle_cleanup_schedule
       WHERE cleanup_at <= ? AND terminal_state IS NULL
       ORDER BY cleanup_at ASC, session_id ASC
       LIMIT ?`,
      now,
      candidateLimit
    )
    .toArray()
    .map((row) => parseIdleCleanupSchedule(row));

  for (const entry of expired) {
    try {
      if (!projectId || !entry.taskId) {
        log.warn('reporter_identity_incomplete', {
          projectId,
          sessionId: entry.sessionId,
          workspaceId: entry.workspaceId,
          taskId: entry.taskId,
          action: 'preserved',
        });
        if (maxResidenceExceeded(entry, now, maxResidenceMs)) {
          markIdleCleanupAttentionRequired(
            sql,
            entry,
            'reporter_identity_incomplete',
            'Idle cleanup reporter identity stayed incomplete until max residence.',
            IDLE_CLEANUP_MAX_RESIDENCE_MESSAGE,
            broadcastEvent
          );
          continue;
        }
        sql.exec(
          `UPDATE idle_cleanup_schedule
           SET cleanup_at = ?,
               last_error = ?
           WHERE session_id = ? AND terminal_state IS NULL`,
          now + retryDelay,
          'reporter_identity_incomplete',
          entry.sessionId
        );
        continue;
      }

      const transition = await terminalizeIdleTaskInD1(sql, env, {
        sweep: 'session_idle_cleanup',
        projectId,
        taskId: entry.taskId,
        workspaceId: entry.workspaceId,
        sessionId: entry.sessionId,
        idleDurationMs: Math.max(0, now - (entry.cleanupAt - timeoutMs)),
        timeoutMs,
      });
      if (transition.outcome === 'preserved') {
        if (maxResidenceExceeded(entry, now, maxResidenceMs)) {
          markIdleCleanupAttentionRequired(
            sql,
            entry,
            'preserved_max_residence_exceeded',
            transition.liveness?.reason ??
              'Idle cleanup runtime liveness stayed inconclusive until max residence.',
            IDLE_CLEANUP_MAX_RESIDENCE_MESSAGE,
            broadcastEvent
          );
          continue;
        }
        sql.exec(
          `UPDATE idle_cleanup_schedule
           SET cleanup_at = ?,
               last_error = ?
           WHERE session_id = ? AND terminal_state IS NULL`,
          now + retryDelay,
          transition.liveness?.reason ?? 'preserved',
          entry.sessionId
        );
        continue;
      }
      if (
        transition.outcome === 'not_active' ||
        transition.outcome === 'not_found' ||
        transition.outcome === 'superseded'
      ) {
        sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', entry.sessionId);
        continue;
      }
      if (transition.outcome === 'rejected') {
        throw new Error('Idle cleanup reporter scope did not match the task');
      }

      // Stop the session in DO SQLite
      stopSessionInternal(sql, entry.sessionId);

      // Clear activity state so the browser status bar reflects idle
      upsertActivityState(sql, entry.sessionId, { activity: 'idle' });

      // Materialize grouped messages (best-effort)
      try {
        materializeSession(sql, entry.sessionId);
      } catch (e) {
        log.error('materialize_session_failed', {
          sessionId: entry.sessionId,
          error: String(e),
        });
      }

      // Stop workspace only after the same task-scoped liveness result proved
      // the runtime conclusively dead and the scoped task transition committed.
      await stopWorkspaceInD1(entry.workspaceId, projectId);

      // Clean up workspace activity tracking
      sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', entry.workspaceId);

      // Remove from schedule
      sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', entry.sessionId);

      // Record activity
      recordActivityEventInternal(
        sql,
        'session.idle_cleanup',
        'system',
        null,
        entry.workspaceId,
        entry.sessionId,
        entry.taskId,
        JSON.stringify({ retryCount: entry.retryCount })
      );
      broadcastEvent(
        'session.idle_cleanup',
        { sessionId: entry.sessionId, workspaceId: entry.workspaceId, taskId: entry.taskId },
        entry.sessionId
      );
      scheduleSummarySync();
    } catch (err) {
      log.error('cleanup_failed', { sessionId: entry.sessionId, ...serializeError(err) });

      if (entry.retryCount >= maxRetries) {
        recordActivityEventInternal(
          sql,
          'session.idle_cleanup_failed',
          'system',
          null,
          entry.workspaceId,
          entry.sessionId,
          entry.taskId,
          JSON.stringify({
            error: errorText(err),
            retryCount: entry.retryCount,
          })
        );
        markIdleCleanupAttentionRequired(
          sql,
          entry,
          'retry_exhausted',
          errorText(err),
          IDLE_CLEANUP_RETRY_EXHAUSTED_MESSAGE,
          broadcastEvent
        );
      } else {
        sql.exec(
          `UPDATE idle_cleanup_schedule
           SET cleanup_at = ?,
               retry_count = ?,
               last_error = ?
           WHERE session_id = ? AND terminal_state IS NULL`,
          now + retryDelay,
          entry.retryCount + 1,
          errorText(err),
          entry.sessionId,
        );
      }
    }
  }
}

/**
 * Check workspace idle timeouts and clean up idle workspaces.
 */
export async function checkWorkspaceIdleTimeouts(
  sql: SqlStorage,
  env: Env,
  projectId: string | null,
  deleteWorkspaceInD1: (workspaceId: string, projectId: string) => Promise<void>,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  scheduleSummarySync: () => void
): Promise<void> {
  const now = Date.now();
  const candidateLimit = positiveInt(
    env.IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
    DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP
  );

  let timeoutMs = parseInt(
    env.WORKSPACE_IDLE_TIMEOUT_MS || String(DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS),
    10
  );

  if (projectId) {
    try {
      const row = await env.DATABASE.prepare(
        'SELECT workspace_idle_timeout_ms FROM projects WHERE id = ?'
      )
        .bind(projectId)
        .first<{ workspace_idle_timeout_ms: number | null }>();
      if (row?.workspace_idle_timeout_ms) {
        timeoutMs = row.workspace_idle_timeout_ms;
      }
    } catch (err) {
      log.warn('d1_project_timeout_query_failed', { projectId, ...serializeError(err) });
    }
  }

  const idleThreshold = now - timeoutMs;

  const activeWorkspaces = sql
    .exec(
      `SELECT wa.workspace_id, wa.session_id, wa.last_terminal_activity_at, wa.last_message_at,
            cs.updated_at as session_updated_at
     FROM workspace_activity wa
     INNER JOIN chat_sessions cs ON cs.id = wa.session_id AND cs.workspace_id = wa.workspace_id
     WHERE cs.status = 'active'
     ORDER BY wa.workspace_id ASC
     LIMIT ?`,
      candidateLimit
    )
    .toArray()
    .map((row) => parseWorkspaceActivity(row));

  for (const ws of activeWorkspaces) {
    const lastActivity = Math.max(ws.lastTerminalActivityAt, ws.lastMessageAt, ws.sessionUpdatedAt);

    if (lastActivity > 0 && lastActivity < idleThreshold) {
      log.info('workspace_idle_timeout', {
        workspaceId: ws.workspaceId,
        sessionId: ws.sessionId,
        lastActivity,
        timeoutMs,
        idleDurationMs: now - lastActivity,
      });

      try {
        if (!projectId || !ws.sessionId) {
          log.warn('workspace_idle_reporter_identity_incomplete', {
            projectId,
            workspaceId: ws.workspaceId,
            sessionId: ws.sessionId,
            action: 'preserved',
          });
          continue;
        }
        const reporterSessionId = ws.sessionId;

        const candidates = await listReporterScopedTaskCandidates(
          env.DATABASE,
          { projectId, workspaceId: ws.workspaceId, sessionId: reporterSessionId },
          candidateLimit
        );
        if (candidates.overflow || candidates.tasks.length === 0) {
          log.warn('workspace_idle_candidates_inconclusive', {
            projectId,
            workspaceId: ws.workspaceId,
            sessionId: reporterSessionId,
            candidateLimit,
            selectedCount: candidates.tasks.length,
            overflow: candidates.overflow,
            action: 'preserved',
          });
          continue;
        }

        const transitions = [];
        for (const { id } of candidates.tasks) {
          transitions.push(
            await terminalizeIdleTaskInD1(sql, env, {
              sweep: 'workspace_idle_timeout',
              projectId,
              taskId: id,
              workspaceId: ws.workspaceId,
              sessionId: reporterSessionId,
              idleDurationMs: now - lastActivity,
              timeoutMs,
            })
          );
        }
        if (!transitions.every((transition) => transition.outcome === 'failed')) {
          log.info('workspace_idle_runtime_preserved', {
            projectId,
            workspaceId: ws.workspaceId,
            sessionId: reporterSessionId,
            outcomes: transitions.map((transition) => transition.outcome),
            reasons: transitions.map((transition) => transition.liveness?.reason ?? null),
            action: 'preserved',
          });
          continue;
        }

        stopSessionInternal(sql, reporterSessionId);
        upsertActivityState(sql, reporterSessionId, { activity: 'idle' });
        try {
          materializeSession(sql, reporterSessionId);
        } catch (e) {
          log.error('materialize_session_on_idle_timeout_failed', {
            sessionId: reporterSessionId,
            error: String(e),
          });
        }

        await deleteWorkspaceInD1(ws.workspaceId, projectId);

        sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', ws.workspaceId);

        const failedTaskIds = transitions.map((transition) => transition.taskId);
        const reporterTaskId = failedTaskIds[0] ?? null;

        recordActivityEventInternal(
          sql,
          'workspace.idle_timeout',
          'system',
          null,
          ws.workspaceId,
          ws.sessionId,
          reporterTaskId,
          JSON.stringify({
            lastActivity,
            timeoutMs,
            idleDurationMs: now - lastActivity,
            failedTaskIds,
          })
        );
        broadcastEvent('workspace.idle_timeout', {
          workspaceId: ws.workspaceId,
          sessionId: ws.sessionId,
          taskId: reporterTaskId,
          failedTaskIds,
        });
        scheduleSummarySync();
      } catch (err) {
        log.error('workspace_idle_timeout_cleanup_failed', {
          workspaceId: ws.workspaceId,
          ...serializeError(err),
        });
      }
    }
  }
}

/**
 * Compute the alarm time for idle cleanup and workspace idle checks.
 */
export function computeIdleAlarmTimes(sql: SqlStorage): {
  idleCleanupTime: number | null;
  workspaceIdleCheckTime: number | null;
} {
  const idleRow = sql
    .exec(
      'SELECT MIN(cleanup_at) as earliest FROM idle_cleanup_schedule WHERE terminal_state IS NULL'
    )
    .toArray()[0];
  const idleCleanupTime = idleRow ? parseMinEarliest(idleRow, 'idle_cleanup.min_cleanup_at') : null;

  let workspaceIdleCheckTime: number | null = null;
  const earliestActivityRow = sql
    .exec(
      `SELECT MIN(COALESCE(
        CASE WHEN last_terminal_activity_at > last_message_at THEN last_terminal_activity_at ELSE last_message_at END,
        last_message_at, created_at
      )) as earliest FROM workspace_activity`
    )
    .toArray()[0];
  const earliestActivity = earliestActivityRow
    ? parseMinEarliest(earliestActivityRow, 'idle_cleanup.min_activity')
    : null;
  if (earliestActivity !== null) {
    const nextCheck = earliestActivity + WORKSPACE_IDLE_CHECK_INTERVAL_MS;
    workspaceIdleCheckTime = Math.max(
      nextCheck,
      Date.now() + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS
    );
  }

  return { idleCleanupTime, workspaceIdleCheckTime };
}
