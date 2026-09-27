import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono, type MiddlewareHandler } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { rateLimitSessionSummarize } from '../middleware/rate-limit';
import * as projectDataService from '../services/project-data';
import {
  getSummarizeConfig,
  summarizeSession,
  type TaskContext,
} from '../services/session-summarize';
import { ensureSessionTaskBacked } from '../services/session-task-repair';

/**
 * Routes that derive a new session from an existing one: `fork-prepare` (Fork) and `summarize`
 * (Retry). Both summarize the source session's history with Workers AI, so both spend from one
 * per-user rate-limit bucket.
 */
const chatForkRoutes = new Hono<{ Bindings: Env }>();

const limitSessionSummarization: MiddlewareHandler<{ Bindings: Env }> = (c, next) =>
  rateLimitSessionSummarize(c.env)(c, next);

chatForkRoutes.post('/:sessionId/fork-prepare', limitSessionSummarization, async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');
  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) throw errors.notFound('Chat session');
  const parentTask = await ensureSessionTaskBacked(db, c.env, {
    projectId,
    sessionId,
    fallbackUserId: typeof session.createdByUserId === 'string' ? session.createdByUserId : userId,
  });

  const { messages } = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    1000,
    null,
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

/**
 * POST /api/projects/:projectId/sessions/:sessionId/summarize
 * Generate a context summary from a session's message history.
 * Used by Retry — the UI pre-fills the new session with this summary for review before
 * submitting it as contextSummary.
 */
chatForkRoutes.post('/:sessionId/summarize', limitSessionSummarization, async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const sessionId = requireRouteParam(c, 'sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:write');

  // Verify session exists
  const session = await projectDataService.getSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('Session not found');
  }

  // Fetch all messages for the session (up to 1000) — compact=false to include full content for summarization
  const { messages: allMessages } = await projectDataService.getMessages(
    c.env,
    projectId,
    sessionId,
    1000,
    null,
    null,
    undefined,
    false
  );

  if (allMessages.length === 0) {
    throw errors.badRequest('Session has no messages');
  }

  // Look up task metadata for enriched context
  let taskContext: TaskContext | undefined;
  const taskId = session.taskId as string | null;
  if (taskId) {
    try {
      const [taskRow] = await db
        .select({
          title: schema.tasks.title,
          description: schema.tasks.description,
          outputBranch: schema.tasks.outputBranch,
          outputPrUrl: schema.tasks.outputPrUrl,
          outputSummary: schema.tasks.outputSummary,
        })
        .from(schema.tasks)
        .where(eq(schema.tasks.id, taskId))
        .limit(1);

      if (taskRow) {
        taskContext = {
          title: taskRow.title ?? undefined,
          description: taskRow.description ?? undefined,
          outputBranch: taskRow.outputBranch ?? undefined,
          outputPrUrl: taskRow.outputPrUrl ?? undefined,
          outputSummary: taskRow.outputSummary ?? undefined,
        };
      }
    } catch {
      // Task lookup failure is non-fatal — summarize without task context
    }
  }

  // Generate summary
  const config = getSummarizeConfig(c.env);
  const result = await summarizeSession(
    c.env,
    allMessages.map((m) => ({
      role: m.role as string,
      content: m.content as string,
      created_at: m.createdAt as number,
    })),
    config,
    taskContext
  );

  return c.json(result);
});

export { chatForkRoutes };
