import { createModuleLogger } from '../../lib/logger';
import * as activity from './activity';
import * as attention from './attention';
import * as idleCleanup from './idle-cleanup';
import type { Env } from './types';

const log = createModuleLogger('project_data.attention_expiry');

export async function processExpiredAttentionMarkers(
  sql: SqlStorage,
  env: Env,
  failSession: (sessionId: string, errorMessage: string) => Promise<void>,
): Promise<void> {
  for (const marker of attention.getExpiredMarkers(sql)) {
    try {
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
}

async function failExpiredTaskMarker(
  sql: SqlStorage,
  env: Env,
  marker: ReturnType<typeof attention.getExpiredMarkers>[number],
  failSession: (sessionId: string, errorMessage: string) => Promise<void>,
): Promise<void> {
  if ((marker.kind !== 'needs_input' && marker.kind !== 'reconciliation_checkin') || !marker.taskId) return;

  const errorMessage = marker.kind === 'reconciliation_checkin'
    ? 'Agent became unresponsive after SAM check-in'
    : 'Human input request expired after timeout';

  await failTaskAndWorkspace(env, marker.taskId, marker.workspaceId, errorMessage);
  await failSession(marker.sessionId, errorMessage);
  activity.recordActivityEventInternal(
    sql, 'attention.expired', 'system', null,
    marker.workspaceId, marker.sessionId, marker.taskId,
    JSON.stringify({ kind: marker.kind, markerId: marker.id }),
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
  errorMessage: string,
): Promise<void> {
  if (!env.DATABASE) return;
  await env.DATABASE.prepare(
    `UPDATE tasks SET status = 'failed', error_message = ?, updated_at = datetime('now') WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`,
  ).bind(errorMessage, taskId).run();
  if (workspaceId) await idleCleanup.stopWorkspaceInD1(env.DATABASE, workspaceId);
}

async function cleanupUnresponsiveTaskRun(env: Env, workspaceId: string, taskId: string): Promise<void> {
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
