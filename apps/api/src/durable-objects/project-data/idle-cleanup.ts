/**
 * Idle cleanup scheduling and workspace idle timeout management.
 */
import {
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import type { Env } from './types';
import { recordActivityEventInternal } from './activity';
import { stopSessionInternal } from './sessions';
import { materializeSession } from './materialization';
import { persistSystemMessage } from './messages';

const log = createModuleLogger('idle_cleanup');

export function scheduleIdleCleanup(
  sql: SqlStorage,
  env: Env,
  sessionId: string,
  workspaceId: string,
  taskId: string | null
): { cleanupAt: number } {
  const timeoutMinutes = parseInt(env.SESSION_IDLE_TIMEOUT_MINUTES || '15', 10);
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
  const timeoutMinutes = parseInt(env.SESSION_IDLE_TIMEOUT_MINUTES || '15', 10);
  const cleanupAt = Date.now() + timeoutMinutes * 60 * 1000;

  const existing = sql
    .exec('SELECT session_id FROM idle_cleanup_schedule WHERE session_id = ?', sessionId)
    .toArray();

  if (existing.length === 0) {
    return { cleanupAt: 0 };
  }

  sql.exec(
    'UPDATE idle_cleanup_schedule SET cleanup_at = ?, retry_count = 0 WHERE session_id = ?',
    cleanupAt,
    sessionId
  );

  return { cleanupAt };
}

export function getCleanupAt(sql: SqlStorage, sessionId: string): number | null {
  const row = sql
    .exec('SELECT cleanup_at FROM idle_cleanup_schedule WHERE session_id = ?', sessionId)
    .toArray()[0];
  return row ? (row.cleanup_at as number) : null;
}

/**
 * Process expired idle cleanup rows. Returns list of processed entries for broadcasting.
 */
export async function processExpiredCleanups(
  sql: SqlStorage,
  env: Env,
  completeTaskInD1: (taskId: string) => Promise<void>,
  stopWorkspaceInD1: (workspaceId: string) => Promise<void>,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  scheduleSummarySync: () => void
): Promise<void> {
  const now = Date.now();
  const maxRetries = parseInt(env.IDLE_CLEANUP_MAX_RETRIES || '1', 10);
  const retryDelay = parseInt(env.IDLE_CLEANUP_RETRY_DELAY_MS || '300000', 10);

  const expired = sql
    .exec(
      'SELECT session_id, workspace_id, task_id, retry_count FROM idle_cleanup_schedule WHERE cleanup_at <= ?',
      now
    )
    .toArray();

  for (const row of expired) {
    const sessionId = row.session_id as string;
    const workspaceId = row.workspace_id as string;
    const taskId = row.task_id as string | null;
    const retryCount = (row.retry_count as number) || 0;

    try {
      // Stop the session in DO SQLite
      stopSessionInternal(sql, sessionId);

      // Materialize grouped messages (best-effort)
      try {
        materializeSession(sql, sessionId);
      } catch (e) {
        log.error('materialize_session_failed', {
          sessionId,
          error: String(e),
        });
      }

      // Update D1
      if (taskId) {
        await completeTaskInD1(taskId);
      }
      await stopWorkspaceInD1(workspaceId);

      // Clean up workspace activity tracking
      sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', workspaceId);

      // Remove from schedule
      sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);

      // Record activity
      recordActivityEventInternal(
        sql,
        'session.idle_cleanup',
        'system',
        null,
        workspaceId,
        sessionId,
        taskId,
        JSON.stringify({ retryCount })
      );
      broadcastEvent('session.idle_cleanup', { sessionId, workspaceId, taskId }, sessionId);
      scheduleSummarySync();
    } catch (err) {
      log.error('cleanup_failed', { sessionId, ...serializeError(err) });

      if (retryCount >= maxRetries) {
        sql.exec('DELETE FROM idle_cleanup_schedule WHERE session_id = ?', sessionId);
        recordActivityEventInternal(
          sql,
          'session.idle_cleanup_failed',
          'system',
          null,
          workspaceId,
          sessionId,
          taskId,
          JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
            retryCount,
          })
        );
        const msgResult = persistSystemMessage(
          sql,
          sessionId,
          'Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.'
        );
        if (msgResult) {
          broadcastEvent('message.new', {
            sessionId,
            messageId: msgResult.id,
            role: 'system',
            content: 'Idle cleanup failed after retries. Your work has been preserved — please check the workspace manually.',
            toolMetadata: null,
            createdAt: msgResult.now,
            sequence: msgResult.sequence,
          }, sessionId);
        }
      } else {
        sql.exec(
          'UPDATE idle_cleanup_schedule SET cleanup_at = ?, retry_count = ? WHERE session_id = ?',
          now + retryDelay,
          retryCount + 1,
          sessionId
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
  deleteWorkspaceInD1: (workspaceId: string) => Promise<void>,
  broadcastEvent: (type: string, payload: Record<string, unknown>, sessionId?: string) => void,
  scheduleSummarySync: () => void
): Promise<void> {
  const now = Date.now();

  let timeoutMs = parseInt(
    env.WORKSPACE_IDLE_TIMEOUT_MS || String(DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS),
    10
  );

  if (projectId) {
    try {
      const row = await env.DATABASE.prepare(
        'SELECT workspace_idle_timeout_ms FROM projects WHERE id = ?'
      ).bind(projectId).first<{ workspace_idle_timeout_ms: number | null }>();
      if (row?.workspace_idle_timeout_ms) {
        timeoutMs = row.workspace_idle_timeout_ms;
      }
    } catch (err) {
      log.warn('d1_project_timeout_query_failed', { projectId, ...serializeError(err) });
    }
  }

  const idleThreshold = now - timeoutMs;

  const activeWorkspaces = sql.exec(
    `SELECT wa.workspace_id, wa.session_id, wa.last_terminal_activity_at, wa.last_message_at,
            cs.updated_at as session_updated_at
     FROM workspace_activity wa
     INNER JOIN chat_sessions cs ON cs.workspace_id = wa.workspace_id
     WHERE cs.status = 'active'`
  ).toArray();

  for (const ws of activeWorkspaces) {
    const workspaceId = ws.workspace_id as string;
    const sessionId = ws.session_id as string | null;
    const lastTerminal = (ws.last_terminal_activity_at as number) || 0;
    const lastMessage = (ws.last_message_at as number) || 0;
    const sessionUpdatedAt = (ws.session_updated_at as number) || 0;

    const lastActivity = Math.max(lastTerminal, lastMessage, sessionUpdatedAt);

    if (lastActivity > 0 && lastActivity < idleThreshold) {
      log.info('workspace_idle_timeout', {
        workspaceId,
        sessionId,
        lastActivity,
        timeoutMs,
        idleDurationMs: now - lastActivity,
      });

      try {
        if (sessionId) {
          stopSessionInternal(sql, sessionId);
          try {
            materializeSession(sql, sessionId);
          } catch (e) {
            log.error('materialize_session_on_idle_timeout_failed', {
              sessionId,
              error: String(e),
            });
          }
        }

        await deleteWorkspaceInD1(workspaceId);
        sql.exec('DELETE FROM workspace_activity WHERE workspace_id = ?', workspaceId);

        recordActivityEventInternal(
          sql,
          'workspace.idle_timeout',
          'system',
          null,
          workspaceId,
          sessionId,
          null,
          JSON.stringify({
            lastActivity,
            timeoutMs,
            idleDurationMs: now - lastActivity,
          })
        );
        broadcastEvent('workspace.idle_timeout', { workspaceId, sessionId });
        scheduleSummarySync();
      } catch (err) {
        log.error('workspace_idle_timeout_cleanup_failed', { workspaceId, ...serializeError(err) });
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
    .exec('SELECT MIN(cleanup_at) as earliest FROM idle_cleanup_schedule')
    .toArray()[0];
  const idleCleanupTime = (idleRow?.earliest as number) ?? null;

  let workspaceIdleCheckTime: number | null = null;
  const earliestActivityRow = sql
    .exec(
      `SELECT MIN(COALESCE(
        CASE WHEN last_terminal_activity_at > last_message_at THEN last_terminal_activity_at ELSE last_message_at END,
        last_message_at, created_at
      )) as earliest FROM workspace_activity`
    )
    .toArray()[0];
  const earliestActivity = earliestActivityRow?.earliest as number | null;
  if (earliestActivity !== null) {
    const nextCheck = earliestActivity + WORKSPACE_IDLE_CHECK_INTERVAL_MS;
    workspaceIdleCheckTime = Math.max(nextCheck, Date.now() + 60_000);
  }

  return { idleCleanupTime, workspaceIdleCheckTime };
}

/**
 * D1 helpers for completing tasks and stopping/deleting workspaces.
 */
export async function completeTaskInD1(db: D1Database, taskId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE tasks SET status = 'completed', execution_step = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('in_progress', 'delegated')`
    )
      .bind(now, now, taskId)
      .run();
  } catch (err) {
    log.error('d1_task_completion_failed', { taskId, ...serializeError(err) });
    throw err;
  }
}

export async function stopWorkspaceInD1(db: D1Database, workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ? AND status IN ('running', 'recovery')`
    )
      .bind(now, workspaceId)
      .run();
  } catch (err) {
    log.error('d1_workspace_stop_failed', { workspaceId, ...serializeError(err) });
    throw err;
  }
}

export async function deleteWorkspaceInD1(db: D1Database, workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    await db.prepare(
      `UPDATE workspaces SET status = 'stopped', updated_at = ? WHERE id = ? AND status IN ('running', 'creating', 'recovery')`
    )
      .bind(now, workspaceId)
      .run();
  } catch (err) {
    log.error('d1_workspace_deletion_failed', { workspaceId, ...serializeError(err) });
    throw err;
  }
}
