import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { requireRouteParam } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import * as chatPersistence from '../services/chat-persistence';
import { ensureSessionTaskBacked } from '../services/session-task-repair';
import { isExecutableTaskStatus, isTaskStatus } from '../services/task-status';
import {
  cleanupTerminalTaskResources,
  type TerminalTaskCleanupStatus,
} from '../services/task-terminal-cleanup';
import { requireSessionCreator } from './chat-session-ownership';
import { resolveLiveAgentSessionForChat } from './chat-workspace-resolver';

type Database = ReturnType<typeof drizzle<typeof schema>>;

interface StopRouteContext {
  projectId: string;
  sessionId: string;
  userId: string;
}

type TaskForStop = {
  id: string;
  status: string;
  errorMessage: string | null;
};

async function findTaskForStop(
  db: Database,
  taskId: string,
  context: StopRouteContext
): Promise<TaskForStop | undefined> {
  const [task] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      errorMessage: schema.tasks.errorMessage,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.id, taskId),
        eq(schema.tasks.projectId, context.projectId),
        eq(schema.tasks.userId, context.userId)
      )
    )
    .limit(1);

  return task;
}

function getTerminalTaskStatus(task: TaskForStop | undefined): TerminalTaskCleanupStatus | null {
  if (task?.status === 'completed' || task?.status === 'failed' || task?.status === 'cancelled') {
    return task.status;
  }

  return null;
}

async function cancelExecutableTaskForArchive(
  db: Database,
  task: TaskForStop,
  taskId: string,
  userId: string
): Promise<void> {
  if (!isTaskStatus(task.status) || !isExecutableTaskStatus(task.status)) {
    return;
  }

  const now = new Date().toISOString();
  await db
    .update(schema.tasks)
    .set({
      status: 'cancelled',
      errorMessage: 'Archived by user',
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(schema.tasks.id, taskId));
  await db.insert(schema.taskStatusEvents).values({
    id: ulid(),
    taskId,
    fromStatus: task.status,
    toStatus: 'cancelled',
    actorType: 'user',
    actorId: userId,
    reason: 'Archived by user',
    createdAt: now,
  });
}

async function stopTaskBackedSession(
  env: Env,
  db: Database,
  taskId: string,
  context: StopRouteContext
): Promise<void> {
  const task = await findTaskForStop(db, taskId, context);
  const terminalStatus = getTerminalTaskStatus(task);

  if (task && !terminalStatus) {
    await cancelExecutableTaskForArchive(db, task, taskId, context.userId);
  }

  const cleanupStatus: TerminalTaskCleanupStatus = terminalStatus ?? 'cancelled';
  await cleanupTerminalTaskResources(env, taskId, {
    status: cleanupStatus,
    errorMessage: cleanupStatus === 'failed' ? (task?.errorMessage ?? null) : 'Archived by user',
    destructiveSessionEnd: true,
    logContext: {
      projectId: context.projectId,
      sessionId: context.sessionId,
      stopPath: 'task-session',
    },
  });
}

/**
 * Tell the agent to stop before we tear its workspace down.
 *
 * Archiving used to be silent from the VM's point of view: the control plane
 * cancelled the task row and deleted the workspace while the agent kept running
 * — and kept spending tokens — until teardown reaped it.
 *
 * Strictly best-effort, and deliberately so. The dominant UI path archives an
 * already-sleeping session, where there is no live workspace at all and
 * `resolveLiveAgentSessionForChat` throws a 404 by design. Archive must succeed
 * regardless of whether anything was there to signal, so every failure here is
 * logged and swallowed. Unlike `/cancel` (which keeps the session alive and
 * therefore must record a turn end), the teardown that follows is what
 * terminalizes the session state.
 */
async function signalAgentStopBestEffort(
  env: Env,
  db: Database,
  context: StopRouteContext
): Promise<void> {
  try {
    const { workspace, agentSession } = await resolveLiveAgentSessionForChat(db, {
      projectId: context.projectId,
      sessionId: context.sessionId,
      userId: context.userId,
    });

    const {
      cancelAgentSessionOnNode,
      stopAgentSessionOnNode,
      getNodeAgentBackgroundRequestTimeoutMs,
    } = await import('../services/node-agent');

    // Both calls run on the BACKGROUND timeout tier, not the interactive one.
    // Neither result is awaited for a decision — the archive proceeds either way
    // — so inheriting the 30s interactive budget would add up to a minute of
    // latency to a foreground archive precisely when the node is unreachable,
    // which is the case where the signal cannot land anyway (.claude/rules/47).
    const requestTimeoutMs = getNodeAgentBackgroundRequestTimeoutMs(env);

    // Cancel first so an in-flight prompt is interrupted rather than left to
    // race the stop, then stop the session host itself.
    await cancelAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      context.userId,
      { requestTimeoutMs }
    );
    await stopAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      agentSession.id,
      env,
      context.userId,
      { requestTimeoutMs }
    );
  } catch (err) {
    log.info('chat.stop_agent_signal_skipped', {
      projectId: context.projectId,
      sessionId: context.sessionId,
      ...serializeError(err),
    });
  }
}

export function registerChatStopRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  /**
   * POST /api/projects/:projectId/sessions/:sessionId/stop
   * Stop a chat session.
   */
  chatRoutes.post('/:sessionId/stop', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await requireSessionCreator(c.env, projectId, sessionId, userId);

    const context = { projectId, sessionId, userId };
    const backingTask = await ensureSessionTaskBacked(db, c.env, {
      projectId,
      sessionId,
      fallbackUserId: userId,
    });
    // Signal the agent BEFORE teardown — once the workspace row is gone there is
    // nothing left to resolve a node from.
    await signalAgentStopBestEffort(c.env, db, context);
    await stopTaskBackedSession(c.env, db, backingTask.id, context);
    await chatPersistence.stopChatSession(c.env, projectId, sessionId);

    return c.json({ status: 'stopped', workspaceDeleted: true });
  });
}
