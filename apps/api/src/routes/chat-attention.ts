/**
 * Attention answers: the agent asked a question with fixed options and a session writer
 * (the owner or an active grantee) picks one. Split out of `chat.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { markRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { parseOptionalBody, ResolveAttentionAnswerSchema } from '../schemas';
import * as projectDataService from '../services/project-data';
import { recordSharedSessionAnswer, requireSessionWriter } from '../services/session-access';
import { preparePromptForLiveAgent, sendPreparedPromptToLiveAgent } from './chat-prompt-forward';

export function registerChatAttentionRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  /**
   * POST /api/projects/:projectId/sessions/:sessionId/attention/:markerId/resolve
   * Validate, deliver, and record one of the agent-provided answer options.
   */
  chatRoutes.post('/:sessionId/attention/:markerId/resolve', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const markerId = requireRouteParam(c, 'markerId');
    const { answer } = await parseOptionalBody(c.req.raw, ResolveAttentionAnswerSchema, {
      answer: '',
    });
    const result = await answerAttention(c.env, userId, projectId, sessionId, markerId, answer);
    return c.json(result, 'inFlight' in result ? 202 : 200);
  });
}

export async function answerAttention(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  markerId: string,
  answer: string
) {
  const db = drizzle(env.DATABASE, { schema });

  const project = await requireProjectCapability(db, projectId, userId, 'task:write');
  const writer = await requireSessionWriter(env, projectId, sessionId, userId, {
    db,
    project,
    requireGranteeRepositoryAccess: true,
    action: 'answer the agent in this session',
  });

  if (!answer) throw markRejectedBeforeEffects(errors.badRequest('answer is required'));

  const prepared = await projectDataService.prepareAttentionAnswer(
    env,
    projectId,
    sessionId,
    markerId,
    answer
  );
  if (prepared.status === 'unsupported_source') {
    throw markRejectedBeforeEffects(
      errors.badRequest('This attention marker must be answered through the interaction route')
    );
  }
  if (prepared.status === 'not_found')
    throw markRejectedBeforeEffects(errors.notFound('Attention request'));
  if (prepared.status === 'invalid_option') {
    throw markRejectedBeforeEffects(
      errors.badRequest('answer must match one of the requested options')
    );
  }
  if (prepared.status === 'already_resolved') {
    if (prepared.answer !== answer)
      throw markRejectedBeforeEffects(errors.conflict('Attention request is already resolved'));
    return { resolved: true, alreadyResolved: true, answer };
  }
  if (prepared.status === 'conflicting_answer') {
    throw markRejectedBeforeEffects(
      errors.conflict('A different answer is already being delivered')
    );
  }
  if (prepared.status === 'in_flight') {
    return { resolved: false, alreadyResolved: false, inFlight: true, answer };
  }

  let preparedPrompt;
  try {
    // The live agent runs as the session owner; resolve its workspace by the owner.
    preparedPrompt = await preparePromptForLiveAgent(env, db, {
      projectId,
      sessionId,
      userId: writer.ownerUserId,
      content: answer,
    });
  } catch (cause) {
    // Resolution/enrichment failed before the mutating request began, so this
    // claim is definitively safe to retry.
    await projectDataService.releaseAttentionAnswer(env, projectId, sessionId, markerId, answer);
    throw cause instanceof Error ? markRejectedBeforeEffects(cause) : cause;
  }

  // Every transport/response error after this boundary is outcome-unknown: the
  // VM agent dispatches asynchronously before responding. Preserve the claim so
  // an approval is never replayed. The marker ID is also propagated as the
  // stable downstream message ID for persistence-level deduplication.
  await sendPreparedPromptToLiveAgent(env, preparedPrompt, markerId);
  await projectDataService.completeAttentionAnswer(env, projectId, sessionId, markerId, answer);
  await recordSharedSessionAnswer(env, writer, { markerId });
  return { resolved: true, alreadyResolved: false, answer };
}
