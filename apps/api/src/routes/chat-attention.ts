/**
 * Attention answers: the agent asked a question with fixed options and a session writer
 * (the owner or an active grantee) picks one. Split out of `chat.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import { HUMAN_INPUT_CATEGORIES, type HumanInputCategory } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';

import * as schema from '../db/schema';
import {
  ATTENTION_ARCHIVE_CLAIM,
  parseAttentionOptions,
} from '../durable-objects/project-data/attention';
import type { Env } from '../env';
import { agentWakeRecord } from '../lib/agent-wake-policy';
import { markRejectedBeforeEffects } from '../lib/operation-effect-boundary';
import { requireRouteParam } from '../lib/route-helpers';
import { parseJsonRecord } from '../lib/runtime-validation';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import {
  hasProjectCapability,
  projectRoleHasCapability,
  requireActiveProjectMembership,
  requireProjectCapability,
} from '../middleware/project-auth';
import { parseOptionalBody, ResolveAttentionAnswerSchema } from '../schemas';
import { authorizeAgentWake } from '../services/agent-wake-authorization';
import { readAskContext } from '../services/inbox/ask-context';
import * as projectDataService from '../services/project-data';
import { recordSharedSessionAnswer } from '../services/session-access';
import { preparePromptForLiveAgent, sendPreparedPromptToLiveAgent } from './chat-prompt-forward';

/** The `request_human_input` category stored with the question, or null when absent/unknown. */
function parseAttentionCategory(metadata: string | null): HumanInputCategory | null {
  if (!metadata) return null;
  try {
    const category = parseJsonRecord(metadata, 'attention.metadata').category;
    return (HUMAN_INPUT_CATEGORIES as readonly unknown[]).includes(category)
      ? (category as HumanInputCategory)
      : null;
  } catch {
    return null;
  }
}

/**
 * One attention marker with what this viewer may do with it. Shared by the attention read below
 * and the inbox (`services/inbox/port.ts`), so both answer "can this person answer?" the same way.
 */
export async function loadAttentionForViewer(
  env: Env,
  projectId: string,
  sessionId: string,
  markerId: string,
  userId: string
) {
  const db = drizzle(env.DATABASE, { schema });
  const { membership } = await requireActiveProjectMembership(db, projectId, userId);
  const { session, access, marker } = await projectDataService.getAttentionRequest(
    env,
    projectId,
    sessionId,
    markerId,
    userId
  );
  const writer =
    Boolean(access.ownerUserId) &&
    projectRoleHasCapability(membership.role, 'task:write') &&
    (access.role === 'owner' ||
      (access.role === 'grantee' &&
        Boolean(access.grant) &&
        (await hasProjectCapability(db, projectId, access.ownerUserId ?? '', 'task:write'))));
  return {
    canRead:
      Boolean(session) && access.found && projectRoleHasCapability(membership.role, 'task:read'),
    session,
    marker:
      marker && marker.sessionId === sessionId && marker.kind === 'needs_input' ? marker : null,
    writer,
  };
}

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
    const { session, marker, writer, canRead } = await loadAttentionForViewer(
      c.env,
      projectId,
      sessionId,
      markerId,
      userId
    );
    if (!session || !canRead) throw errors.notFound('Chat session');
    if (!marker) throw errors.notFound('Attention request');
    const expired = marker.expiresAt !== null && marker.expiresAt <= Date.now();
    const context =
      c.req.query('context') === 'true'
        ? await readAskContext(c.env, {
            projectId,
            sessionId,
            askedAt: marker.createdAt,
            requestedLimit: Number(c.req.query('limit')),
          })
        : null;
    return c.json({
      request: {
        id: marker.id,
        reason: marker.reason,
        options: parseAttentionOptions(marker.metadata),
        category: parseAttentionCategory(marker.metadata),
        createdAt: marker.createdAt,
        resolvedAt: marker.resolvedAt,
        // A staged inbox archive is not an answer; it never leaves the API.
        resolvedAnswer:
          marker.resolvedAnswer === ATTENTION_ARCHIVE_CLAIM ? null : marker.resolvedAnswer,
        expired,
        canAnswer:
          marker.source === 'request_human_input' &&
          !expired &&
          marker.resolvedAt === null &&
          marker.resolvedAnswer === null &&
          writer,
      },
      session: { id: sessionId, topic: typeof session.topic === 'string' ? session.topic : null },
      // Messages before the question, oldest first.
      messages: (context?.before ?? []).map((message) => ({
        id: message.id,
        sessionId,
        role: message.role,
        content: message.content,
        createdAt: message.createdAt,
        toolMetadata: null,
        truncated: message.truncated,
      })),
      // What the agent did since asking: messages after it, and how many tool runs.
      since: context?.since ?? null,
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
  // The answer reaches the agent as a new prompt, so the agent-wake policy decides.
  const { writer, wake } = await authorizeAgentWake(env, {
    projectId,
    sessionId,
    actorUserId: userId,
    trigger: 'attention_answer',
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
  // The answer goes straight to the live agent, not through the prompt-delivery queue, so
  // there is no delivery row to carry `metadata.wake`. A teammate's answer records it on the
  // shared-answer audit event instead; an owner's answer is the owner acting for themself.
  await recordSharedSessionAnswer(env, writer, { markerId, wake: agentWakeRecord(wake) });
  return { resolved: true, alreadyResolved: false, answer };
}

/** What the agent is told when the person archives its question (spec section 3.3). */
export function attentionArchivedPrompt(reason: string | null): string {
  const quoted = reason ? ` ("${reason.trim().slice(0, 300)}")` : '';
  return `The person archived your question${quoted} from their inbox and will not act on it. Do not wait for an answer: continue without it, or end your turn and say what is left undone.`;
}

/**
 * Archive a question still held as an attention marker: resolve it with reason `archived` and
 * tell the agent through the same path an answer takes (`answerAttention`): the same wake
 * authorization, the same claim (so an answer and an archive cannot both win), the same
 * live-agent prompt, deduplicated on the marker id.
 */
export async function archiveAttention(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  markerId: string
): Promise<{ agentNotified: boolean }> {
  const db = drizzle(env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');
  const { writer, wake } = await authorizeAgentWake(env, {
    projectId,
    sessionId,
    actorUserId: userId,
    trigger: 'attention_answer',
    db,
    action: 'archive the agent question in this session',
  });
  const viewer = await projectDataService.getAttentionRequest(
    env,
    projectId,
    sessionId,
    markerId,
    userId
  );
  const prepared = await projectDataService.prepareAttentionArchive(
    env,
    projectId,
    sessionId,
    markerId
  );
  if (prepared.status === 'unsupported_source')
    throw markRejectedBeforeEffects(
      errors.badRequest('This request must be declined through the interaction route')
    );
  if (prepared.status === 'not_found')
    throw markRejectedBeforeEffects(errors.notFound('Attention request'));
  if (prepared.status === 'already_resolved')
    throw markRejectedBeforeEffects(errors.conflict('Attention request is already resolved'));
  if (prepared.status === 'conflicting_answer' || prepared.status === 'invalid_option')
    throw markRejectedBeforeEffects(errors.conflict('An answer is already being delivered'));
  if (prepared.status === 'in_flight') return { agentNotified: false };

  let preparedPrompt;
  try {
    preparedPrompt = await preparePromptForLiveAgent(env, db, {
      projectId,
      sessionId,
      userId: writer.ownerUserId,
      content: attentionArchivedPrompt(viewer.marker?.reason ?? null),
    });
  } catch (cause) {
    await projectDataService.releaseAttentionArchive(env, projectId, sessionId, markerId);
    throw cause instanceof Error ? markRejectedBeforeEffects(cause) : cause;
  }
  // Outcome-unknown from here, exactly as for an answer: keep the claim, never replay.
  await sendPreparedPromptToLiveAgent(env, preparedPrompt, markerId);
  await projectDataService.completeAttentionArchive(env, projectId, sessionId, markerId);
  await recordSharedSessionAnswer(env, writer, { markerId, wake: agentWakeRecord(wake) });
  return { agentNotified: true };
}
