/**
 * Attention answers: the agent asked a question with fixed options and a session writer
 * (the owner or an active grantee) picks one. Split out of `chat.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import { parseAttentionOptions } from '../durable-objects/project-data/attention';
import type { Env } from '../env';
import { markRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  hasProjectCapability,
  projectRoleHasCapability,
  requireActiveProjectMembership,
  requireProjectCapability,
} from '../middleware/project-auth';
import { parseOptionalBody, ResolveAttentionAnswerSchema } from '../schemas';
import { getCommentContextLimits } from '../services/collaboration-settings';
import { getConnectorReadLimits } from '../services/connector-read-settings';
import * as projectDataService from '../services/project-data';
import { recordSharedSessionAnswer, requireSessionWriter } from '../services/session-access';
import { getSessionMessageLimit } from './chat-message-query';
import { preparePromptForLiveAgent, sendPreparedPromptToLiveAgent } from './chat-prompt-forward';

export function registerChatAttentionRoute(chatRoutes: Hono<{ Bindings: Env }>): void {
  // Read-only: no runtime contact or whole-conversation fetch. Context is opt-in.
  chatRoutes.get('/:sessionId/attention/:markerId', async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const sessionId = requireRouteParam(c, 'sessionId');
    const markerId = requireRouteParam(c, 'markerId');
    const db = drizzle(c.env.DATABASE, { schema });
    const { membership } = await requireActiveProjectMembership(db, projectId, userId);
    if (!projectRoleHasCapability(membership.role, 'task:read'))
      throw errors.forbidden('Project capability is required');
    const { session, access, marker } = await projectDataService.getAttentionRequest(
      c.env,
      projectId,
      sessionId,
      markerId,
      userId
    );
    if (!session || !access.found) throw errors.notFound('Chat session');
    if (!marker || marker.sessionId !== sessionId || marker.kind !== 'needs_input')
      throw errors.notFound('Attention request');
    const writer =
      Boolean(access.ownerUserId) &&
      projectRoleHasCapability(membership.role, 'task:write') &&
      (access.role === 'owner' ||
        (access.role === 'grantee' &&
          Boolean(access.grant) &&
          (await hasProjectCapability(db, projectId, access.ownerUserId ?? '', 'task:write'))));
    const expired = marker.expiresAt !== null && marker.expiresAt <= Date.now();
    const requested = Number(c.req.query('limit'));
    // Share the existing admin-editable context setting with the comment reader.
    const settings =
      c.req.query('context') === 'true'
        ? await Promise.all([getCommentContextLimits(c.env), getConnectorReadLimits(c.env)])
        : null;
    const context = settings?.[0];
    const bounds = settings?.[1];
    const limit = context
      ? getSessionMessageLimit(
          c.env,
          String(Number.isSafeInteger(requested) && requested > 0 ? requested : context.messages)
        )
      : 0;
    const page =
      bounds && context
        ? await projectDataService.getLogicalTranscriptPage(c.env, projectId, sessionId, {
            before: marker.createdAt,
            limit,
            roles: ['user', 'assistant'],
            maxScanRows: Math.min(context.maxRows, bounds.transcriptScanRows),
            maxMessageChars: bounds.transcriptMessageChars,
            maxPageChars: bounds.transcriptPageChars,
            includeLatest: false,
            includeToolTitles: false,
          })
        : null;
    const messages =
      page?.entries
        .flatMap((entry) =>
          entry.kind === 'message'
            ? [
                {
                  id: entry.messageId,
                  sessionId,
                  role: entry.role,
                  content: entry.content,
                  createdAt: entry.createdAt,
                  toolMetadata: null,
                  sequence: entry.start?.sequence,
                  truncated: entry.truncated || !entry.complete,
                },
              ]
            : []
        )
        .reverse() ?? [];
    return c.json({
      request: {
        id: marker.id,
        reason: marker.reason,
        options: parseAttentionOptions(marker.metadata),
        createdAt: marker.createdAt,
        resolvedAt: marker.resolvedAt,
        resolvedAnswer: marker.resolvedAnswer,
        expired,
        canAnswer:
          marker.source === 'request_human_input' &&
          !expired &&
          marker.resolvedAt === null &&
          marker.resolvedAnswer === null &&
          writer,
      },
      session: { id: sessionId, topic: typeof session.topic === 'string' ? session.topic : null },
      messages,
    });
  });

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

  await requireProjectCapability(db, projectId, userId, 'task:write');
  const writer = await requireSessionWriter(env, projectId, sessionId, userId, {
    db,
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
