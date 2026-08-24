import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { recordActivityEventInternal } from './activity';
import * as idleCleanup from './idle-cleanup';
import * as sessions from './sessions';
import type { Env as DOEnv } from './types';

const log = createModuleLogger('reconciliation');

export interface ReconciliationProcessingHooks {
  waitUntil?: (promise: Promise<unknown>) => void;
  projectId?: string | null;
  /**
   * Schedule a D1 session-index resync. This path terminalizes a session, so it
   * is a `chat_sessions` writer like every other one — and it was the only such
   * writer with no sync hook, so the index went on reporting the session as
   * active until some unrelated write happened to resync the project.
   * See .claude/rules/44 (enumerate every writer).
   */
  scheduleSummarySync?: () => void;
}

interface DeadTargetCandidate {
  sessionId: string;
  workspaceId: string;
  taskId: string;
  acpSessionId: string;
  idleDurationMs: number;
  action: 'checkin' | 'observe_prompt' | 'cancel_prompt';
  promptAgeMs: number | null;
}

interface DeadTargetResult {
  reason: string;
  nodeId: string | null;
}

function waitUntil(hooks: ReconciliationProcessingHooks, promise: Promise<unknown>): void {
  if (hooks.waitUntil) {
    hooks.waitUntil(promise);
    return;
  }
  void promise;
}

export async function terminallyFailDeadTarget(
  sql: SqlStorage,
  env: DOEnv,
  candidate: DeadTargetCandidate,
  targetResult: DeadTargetResult,
  hooks: ReconciliationProcessingHooks,
): Promise<void> {
  const errorMessage = `Agent workspace unavailable during reconciliation (${targetResult.reason})`;

  await failTaskAndWorkspace(env, candidate.taskId, candidate.workspaceId, hooks.projectId ?? null, errorMessage);
  sessions.failSession(sql, candidate.sessionId);
  hooks.scheduleSummarySync?.();
  recordActivityEventInternal(
    sql,
    'reconciliation.dead_target_failed',
    'system',
    null,
    candidate.workspaceId,
    candidate.sessionId,
    candidate.taskId,
    JSON.stringify({
      acpSessionId: candidate.acpSessionId,
      action: candidate.action,
      reason: targetResult.reason,
      nodeId: targetResult.nodeId,
      idleDurationMs: candidate.idleDurationMs,
      promptAgeMs: candidate.promptAgeMs,
    }),
  );

  waitUntil(hooks, cleanupTaskRun(env, candidate.workspaceId, candidate.taskId));

  log.warn('reconciliation.dead_target_failed', {
    sessionId: candidate.sessionId,
    taskId: candidate.taskId,
    workspaceId: candidate.workspaceId,
    acpSessionId: candidate.acpSessionId,
    action: candidate.action,
    reason: targetResult.reason,
    nodeId: targetResult.nodeId,
  });
}

async function failTaskAndWorkspace(
  env: DOEnv,
  taskId: string,
  workspaceId: string,
  projectId: string | null,
  errorMessage: string,
): Promise<void> {
  if (projectId) {
    const now = new Date().toISOString();
    await env.DATABASE.prepare(
      `UPDATE tasks
       SET status = 'failed', error_message = ?, updated_at = datetime('now')
       WHERE id = ? AND project_id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`,
    ).bind(errorMessage, taskId, projectId).run();
    await env.DATABASE.prepare(
      `UPDATE workspaces
       SET status = 'stopped', updated_at = ?
       WHERE id = ? AND project_id = ? AND status IN ('running', 'recovery')`,
    ).bind(now, workspaceId, projectId).run();
    return;
  }

  log.warn('reconciliation.project_scope_missing_for_d1_failure', {
    taskId,
    workspaceId,
    action: 'unscoped_legacy_update',
  });
  await env.DATABASE.prepare(
    `UPDATE tasks
     SET status = 'failed', error_message = ?, updated_at = datetime('now')
     WHERE id = ? AND status IN ('in_progress', 'delegated', 'awaiting_followup')`,
  ).bind(errorMessage, taskId).run();
  await idleCleanup.stopWorkspaceInD1(env.DATABASE, workspaceId);
}

async function cleanupTaskRun(env: DOEnv, workspaceId: string, taskId: string): Promise<void> {
  try {
    const workerEnv = env as unknown as WorkerEnv;
    const { cleanupTaskRun: cleanup } = await import('../../services/task-runner');
    await cleanup(taskId, workerEnv);
  } catch (err) {
    log.error('reconciliation.cleanup_task_run_failed', {
      workspaceId,
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
