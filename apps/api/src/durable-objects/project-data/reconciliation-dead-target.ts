import type { Env as WorkerEnv } from '../../env';
import { createModuleLogger } from '../../lib/logger';
import { transitionTaskToTerminal } from '../../services/task-terminal-transition';
import { recordActivityEventInternal } from './activity';
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
  projectId?: string | null;
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
  hooks: ReconciliationProcessingHooks
): Promise<void> {
  const errorMessage = `Agent workspace unavailable during reconciliation (${targetResult.reason})`;
  const projectId = hooks.projectId ?? targetResult.projectId ?? null;

  const transitionOutcome = await transitionTaskToTerminal(env as unknown as WorkerEnv, {
    taskId: candidate.taskId,
    projectId,
    status: 'failed',
    reason: errorMessage,
    source: 'project_data.reconciliation.dead_target',
    expectedWorkspaceId: candidate.workspaceId,
    expectedChatSessionId: candidate.sessionId,
    stopWorkspace: true,
  });
  if (transitionOutcome !== 'transitioned') {
    log.warn('reconciliation.dead_target_terminal_transition_skipped', {
      sessionId: candidate.sessionId,
      taskId: candidate.taskId,
      workspaceId: candidate.workspaceId,
      acpSessionId: candidate.acpSessionId,
      action: candidate.action,
      reason: targetResult.reason,
      transitionOutcome,
    });
    return;
  }
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
    })
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
