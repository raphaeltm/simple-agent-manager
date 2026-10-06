import type { OrchestratorConfig } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import { logDecision } from './decision-log';

interface StallTaskRow {
  id: string;
  status: string;
  updated_at: string;
}

interface TaskSessionRow extends Record<string, unknown> {
  id: string;
  taskId: string;
  status: 'active';
}

export async function detectStalls(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  tasks: StallTaskRow[],
  config: OrchestratorConfig,
  now: number
): Promise<void> {
  const stallThreshold = now - config.stallTimeoutMs;
  const runningTasks = tasks.filter(
    (task) => task.status === 'running' || task.status === 'delegated'
  );
  const sessionResolutions = await resolveActiveSessionIdsForTaskIds(
    env,
    projectId,
    runningTasks.map((task) => task.id)
  );

  for (const task of runningTasks) {
    const updatedAt = new Date(task.updated_at).getTime();
    if (updatedAt > stallThreshold) continue;

    const recentStall = sql
      .exec(
        `SELECT 1 FROM decision_log
         WHERE task_id = ? AND action = 'stall_detected'
         AND created_at > ? LIMIT 1`,
        task.id,
        stallThreshold
      )
      .toArray();
    if (recentStall.length > 0) continue;

    const targetSessionId = sessionResolutions.get(task.id) ?? null;
    if (!targetSessionId) {
      const reason = 'No active chat session found for stalled task; interrupt not enqueued';
      log.warn('orchestrator.stall_target_session_missing', {
        projectId,
        missionId,
        taskId: task.id,
        reason,
      });
      logDecision(sql, missionId, task.id, 'skip', reason, now, {
        reason: 'missing_target_session',
        stallDurationMs: now - updatedAt,
      });
      continue;
    }

    try {
      await projectDataService.enqueueMailboxMessage(env, projectId, {
        targetSessionId,
        sourceTaskId: null,
        senderType: 'orchestrator',
        senderId: `orchestrator:${projectId}`,
        messageClass: 'interrupt',
        content:
          `[Orchestrator] This task has not reported progress for ${Math.round(config.stallTimeoutMs / 60000)} minutes. ` +
          'Please provide a status update. If you are blocked, update your task status or request human input.',
        metadata: { reason: 'stall_detection', stallDurationMs: now - updatedAt },
      });

      logDecision(
        sql,
        missionId,
        task.id,
        'stall_detected',
        `Task stalled for ${Math.round((now - updatedAt) / 60000)}min — interrupt sent`,
        now
      );
      log.info('orchestrator.stall_detected', {
        projectId,
        missionId,
        taskId: task.id,
        stallDurationMs: now - updatedAt,
      });
    } catch (err) {
      log.warn('orchestrator.stall_interrupt_failed', {
        projectId,
        missionId,
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

export async function resolveActiveSessionIdsForTaskIds(
  env: Env,
  projectId: string,
  taskIds: string[]
): Promise<Map<string, string>> {
  const uniqueTaskIds = [...new Set(taskIds)];
  const sessions = await projectDataService.getSessionsByTaskIds(env, projectId, uniqueTaskIds);
  const resolved = new Map<string, string>();

  for (const taskId of uniqueTaskIds) {
    const session = sessions.find((candidate) => isActiveSessionForTask(candidate, taskId));
    if (session) resolved.set(taskId, session.id);
  }
  return resolved;
}

function isActiveSessionForTask(
  candidate: Record<string, unknown>,
  taskId: string
): candidate is TaskSessionRow {
  return (
    candidate.taskId === taskId && candidate.status === 'active' && typeof candidate.id === 'string'
  );
}
