import type { OrchestratorConfig, TaskStatus } from '@simple-agent-manager/shared';

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
  lastMessageAt?: unknown;
}

interface ActiveTaskSession {
  id: string;
  /** Epoch ms of the session's newest message, or null when unknown. */
  lastMessageAt: number | null;
}

/** Task statuses that hold a running agent and so can stall. */
const STALL_CHECKED_TASK_STATUSES: readonly TaskStatus[] = ['delegated', 'in_progress'];

function isStallCheckedStatus(status: string): boolean {
  return (STALL_CHECKED_TASK_STATUSES as readonly string[]).includes(status);
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
  const runningTasks = tasks.filter((task) => isStallCheckedStatus(task.status));
  const sessionResolutions = await resolveActiveSessionsForTaskIds(
    env,
    projectId,
    runningTasks.map((task) => task.id)
  );

  for (const task of runningTasks) {
    // Progress is the newer of the task row's last change and the session's newest
    // message. `tasks.updated_at` alone is the wrong signal: progress reports
    // (`update_task_status`) and agent output never touch it, so a busy agent would
    // look stalled (rule 74: key on the condition, not a correlated signal).
    const session = sessionResolutions.get(task.id) ?? null;
    const updatedAt = Math.max(
      new Date(task.updated_at).getTime(),
      session?.lastMessageAt ?? Number.NEGATIVE_INFINITY
    );
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

    const targetSessionId = session?.id ?? null;
    if (!targetSessionId) {
      const reason = 'No active chat session found for stalled task; nudge not enqueued';
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
        // `deliver`, not `interrupt`: an urgent class cancels the agent's in-flight
        // turn (`isUrgentMessageClass`), and an agent that is mid-turn without new
        // output (a long build or test run) is working, not stalled. `deliver` queues
        // behind a busy turn and reaches an idle agent at once. Hung turns are the
        // stuck-task sweep's job, not this nudge's.
        messageClass: 'deliver',
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
        `Task stalled for ${Math.round((now - updatedAt) / 60000)}min — status nudge sent`,
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
  const sessions = await resolveActiveSessionsForTaskIds(env, projectId, taskIds);
  return new Map([...sessions].map(([taskId, session]) => [taskId, session.id]));
}

async function resolveActiveSessionsForTaskIds(
  env: Env,
  projectId: string,
  taskIds: string[]
): Promise<Map<string, ActiveTaskSession>> {
  const uniqueTaskIds = [...new Set(taskIds)];
  const sessions = await projectDataService.getSessionsByTaskIds(env, projectId, uniqueTaskIds);
  const resolved = new Map<string, ActiveTaskSession>();

  for (const taskId of uniqueTaskIds) {
    const session = sessions.find((candidate) => isActiveSessionForTask(candidate, taskId));
    if (session) {
      resolved.set(taskId, { id: session.id, lastMessageAt: toEpochMs(session.lastMessageAt) });
    }
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
