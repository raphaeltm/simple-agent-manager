import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';
import { ensureSessionTaskBacked } from '../services/session-task-repair';
import { getSummarizeConfig, summarizeSession } from '../services/session-summarize';
import { requireSessionCreator } from './chat-session-ownership';

const chatForkRoutes = new Hono<{ Bindings: Env }>();

chatForkRoutes.post('/:sessionId/fork-prepare', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  const session = await requireSessionCreator(c.env, projectId, sessionId, userId);
  const parentTask = await ensureSessionTaskBacked(db, c.env, {
    projectId,
    sessionId,
    fallbackUserId: userId,
  });

  const { messages } = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    1000,
    null,
    undefined,
    false
  );
  if (messages.length === 0) throw errors.badRequest('Session has no messages');

  const summary = await summarizeSession(
    c.env,
    messages.map((message) => ({
      role: String(message.role),
      content: String(message.content),
      created_at: Number(message.createdAt),
    })),
    getSummarizeConfig(c.env),
    {
      title: parentTask.title,
      description: parentTask.description ?? undefined,
      outputBranch: parentTask.outputBranch ?? undefined,
      outputPrUrl: parentTask.outputPrUrl ?? undefined,
      outputSummary: parentTask.outputSummary ?? undefined,
    }
  );

  return c.json({
    parentTaskId: parentTask.id,
    parentSessionId: sessionId,
    parentBranch: parentTask.outputBranch,
    sessionLabel:
      typeof session.topic === 'string' && session.topic.trim()
        ? session.topic
        : `Chat ${sessionId.slice(0, 8)}`,
    summary: summary.summary,
    messageCount: summary.messageCount,
    repaired: !session.taskId,
  });
});

export { chatForkRoutes };
