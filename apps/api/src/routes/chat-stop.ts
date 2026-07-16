import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
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
    logContext: {
      projectId: context.projectId,
      sessionId: context.sessionId,
      stopPath: 'task-session',
    },
  });
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
      projectId, sessionId, fallbackUserId: userId,
    });
    await stopTaskBackedSession(c.env, db, backingTask.id, context);
    await chatPersistence.stopChatSession(c.env, projectId, sessionId);

    return c.json({ status: "stopped", workspaceDeleted: true });
  });
}
