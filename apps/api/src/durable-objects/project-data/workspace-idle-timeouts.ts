/**
 * Workspace idle timeouts: the ProjectData alarm section that retires a workspace whose active chat
 * session has gone quiet for the project's workspace idle timeout, and the alarm time it needs.
 */
import {
  DEFAULT_IDLE_CLEANUP_MAX_CANDIDATES_PER_SWEEP,
  DEFAULT_WORKSPACE_IDLE_BACKOFF_BASE_MS,
  DEFAULT_WORKSPACE_IDLE_BACKOFF_MAX_MS,
  DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS,
  DEFAULT_WORKSPACE_IDLE_TIMEOUT_MS,
  WORKSPACE_IDLE_CHECK_INTERVAL_MS,
} from '@simple-agent-manager/shared';

import { createModuleLogger, serializeError } from '../../lib/logger';
import { parsePositiveInt } from '../../lib/route-helpers';
import { recordActivityEventInternal } from './activity';
import {
  listReporterScopedTaskCandidates,
  terminalizeIdleTaskInD1,
} from './idle-cleanup-terminalization';
import { materializeSession, resolveMaterializationPassConfig } from './materialization';
import { parseMinEarliest, parseWorkspaceActivity } from './row-schemas';
import { upsertActivityState } from './session-state';
import { stopSessionInternal } from './sessions';
import type { Env } from './types';

// Shares the `idle_cleanup` log namespace so the existing event names are unchanged.
const log = createModuleLogger('idle_cleanup');
const WORKSPACE_IDLE_BACKOFF_EXPONENT_SAFETY_CAP = 30;

function boundedWorkspaceIdleBackoffMs(env: Env, retryCount: number): number {
  const baseMs = parsePositiveInt(
    env.WORKSPACE_IDLE_BACKOFF_BASE_MS,
    DEFAULT_WORKSPACE_IDLE_BACKOFF_BASE_MS
  );
  const maxMs = Math.max(
    baseMs,
    parsePositiveInt(env.WORKSPACE_IDLE_BACKOFF_MAX_MS, DEFAULT_WORKSPACE_IDLE_BACKOFF_MAX_MS)
  );
  const exponent = Math.min(Math.max(retryCount, 0), WORKSPACE_IDLE_BACKOFF_EXPONENT_SAFETY_CAP);
  return Math.min(baseMs * 2 ** exponent, maxMs);
}

function deferWorkspaceIdleCheck(
  sql: SqlStorage,
  env: Env,
  workspaceId: string,
  now: number,
  reason: string,
  currentRetryCount: number
): { retryCount: number; nextIdleCheckAt: number } {
  const nextRetryCount = currentRetryCount + 1;
  const nextIdleCheckAt = now + boundedWorkspaceIdleBackoffMs(env, currentRetryCount);
  sql.exec(
    `UPDATE workspace_activity
     SET idle_check_retry_count = ?,
         next_idle_check_at = ?
     WHERE workspace_id = ?`,
    nextRetryCount,
    nextIdleCheckAt,
    workspaceId
  );
  log.info('workspace_idle_check_deferred', {
    workspaceId,
    reason,
    retryCount: nextRetryCount,
    nextIdleCheckAt,
  });
  return { retryCount: nextRetryCount, nextIdleCheckAt };
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
  const candidateLimit = parsePositiveInt(
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
            wa.idle_check_retry_count, wa.next_idle_check_at,
            cs.updated_at as session_updated_at
     FROM workspace_activity wa
     INNER JOIN chat_sessions cs ON cs.id = wa.session_id AND cs.workspace_id = wa.workspace_id
     WHERE cs.status = 'active'
       AND (wa.next_idle_check_at IS NULL OR wa.next_idle_check_at <= ?)
     ORDER BY wa.workspace_id ASC
     LIMIT ?`,
      now,
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
          deferWorkspaceIdleCheck(
            sql,
            env,
            ws.workspaceId,
            now,
            'reporter_identity_incomplete',
            ws.idleCheckRetryCount
          );
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
          deferWorkspaceIdleCheck(
            sql,
            env,
            ws.workspaceId,
            now,
            candidates.overflow ? 'candidate_overflow' : 'no_candidate_tasks',
            ws.idleCheckRetryCount
          );
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
          // Do not reset the retry counter for a conclusive "not idle yet" result here.
          // Terminal and message activity reset it as positive new activity; repeated preserved
          // runtime checks without new activity should continue widening the retry cadence.
          deferWorkspaceIdleCheck(
            sql,
            env,
            ws.workspaceId,
            now,
            'runtime_preserved',
            ws.idleCheckRetryCount
          );
          continue;
        }

        stopSessionInternal(sql, reporterSessionId);
        upsertActivityState(sql, reporterSessionId, { activity: 'idle' });
        try {
          materializeSession(sql, reporterSessionId, resolveMaterializationPassConfig(env));
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
 * Compute the alarm time for workspace idle checks.
 */
export function computeWorkspaceIdleAlarmTime(sql: SqlStorage): number | null {
  const earliestActivityRow = sql
    .exec(
      `SELECT MIN(
        CASE
          WHEN wa.next_idle_check_at IS NOT NULL
           AND wa.next_idle_check_at > max(
             COALESCE(wa.last_terminal_activity_at, 0),
             COALESCE(wa.last_message_at, 0),
             COALESCE(cs.updated_at, 0),
             wa.created_at
           ) + ?
          THEN wa.next_idle_check_at
          ELSE max(
            COALESCE(wa.last_terminal_activity_at, 0),
            COALESCE(wa.last_message_at, 0),
            COALESCE(cs.updated_at, 0),
            wa.created_at
          ) + ?
        END
      ) as earliest
       FROM workspace_activity wa
       INNER JOIN chat_sessions cs ON cs.id = wa.session_id AND cs.workspace_id = wa.workspace_id
       WHERE cs.status = 'active'`,
      WORKSPACE_IDLE_CHECK_INTERVAL_MS,
      WORKSPACE_IDLE_CHECK_INTERVAL_MS
    )
    .toArray()[0];
  const earliestActivity = earliestActivityRow
    ? parseMinEarliest(earliestActivityRow, 'idle_cleanup.min_activity')
    : null;
  if (earliestActivity === null) return null;
  return Math.max(earliestActivity, Date.now() + DEFAULT_WORKSPACE_IDLE_MIN_ALARM_DELAY_MS);
}
