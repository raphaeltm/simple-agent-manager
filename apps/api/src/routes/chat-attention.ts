/**
 * Attention answers: the agent asked a question with fixed options and a session writer
 * (the owner or an active grantee) picks one. Split out of `chat.ts`
 * (`.claude/rules/18-file-size-limits.md`).
 */
import type { ArchiveCheckinHold } from '@simple-agent-manager/operations';
import {
  ACP_INTERACTION_ATTENTION_SOURCE,
  HUMAN_INPUT_CATEGORIES,
  type HumanInputCategory,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Context, Hono } from 'hono';

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
import { announceQuestionArchived } from '../services/inbox/agent-asks';
import { readAskContext } from '../services/inbox/ask-context';
import {
  answerQuestionAsk,
  loadQuestionAsk,
  type QuestionAsk,
  questionAskRequestState,
} from '../services/inbox/question-asks';
import * as projectDataService from '../services/project-data';
import { recordSharedSessionAnswer, requireSessionWriter } from '../services/session-access';
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
 * Whether the viewer may answer the agent in this chat: the owner, or an active grantee whose
 * owner can still write, holding `task:write` themselves. One rule for a question held as a
 * marker and one held in `asks`.
 */
async function isChatWriter(
  db: ReturnType<typeof drizzle<typeof schema>>,
  projectId: string,
  role: string,
  access: { role?: string | null; ownerUserId?: string | null; grant?: unknown }
): Promise<boolean> {
  return (
    Boolean(access.ownerUserId) &&
    projectRoleHasCapability(role, 'task:write') &&
    (access.role === 'owner' ||
      (access.role === 'grantee' &&
        Boolean(access.grant) &&
        (await hasProjectCapability(db, projectId, access.ownerUserId ?? '', 'task:write'))))
  );
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
  const writer = await isChatWriter(db, projectId, membership.role, access);
  return {
    canRead:
      Boolean(session) && access.found && projectRoleHasCapability(membership.role, 'task:read'),
    session,
    marker:
      marker && marker.sessionId === sessionId && marker.kind === 'needs_input' ? marker : null,
    writer,
  };
}

/**
 * The chat card's read of a question held in D1 `asks`, in the shape a marker read had. Who may
 * read and answer is decided as for a marker: any reader of the chat reads it, a writer of the
 * chat (owner, or a grantee whose owner can still write) answers it.
 */
async function questionAskAttentionResponse(
  c: Context<{ Bindings: Env }>,
  ask: QuestionAsk,
  role: string,
  userId: string
) {
  const db = drizzle(c.env.DATABASE, { schema });
  const { session, access } = await projectDataService.getSessionAccess(
    c.env,
    ask.projectId,
    ask.sessionId,
    userId
  );
  if (!session || !access.found || !projectRoleHasCapability(role, 'task:read'))
    throw errors.notFound('Chat session');
  const writer = await isChatWriter(db, ask.projectId, role, access);
  const now = Date.now();
  const state = questionAskRequestState(ask, now);
  const context =
    c.req.query('context') === 'true'
      ? await readAskContext(c.env, {
          projectId: ask.projectId,
          sessionId: ask.sessionId,
          askedAt: ask.createdAt,
          requestedLimit: Number(c.req.query('limit')),
        })
      : null;
  return {
    request: {
      id: ask.id,
      reason: ask.reason,
      options: ask.options,
      category: ask.category,
      createdAt: ask.createdAt,
      resolvedAt: state.resolvedAt,
      resolvedAnswer: state.resolvedAnswer,
      expired: state.expired,
      canAnswer: ask.status === 'open' && !state.expired && writer,
    },
    session: {
      id: ask.sessionId,
      topic: typeof session.topic === 'string' ? session.topic : null,
    },
    messages: (context?.before ?? []).map((message) => ({
      id: message.id,
      sessionId: ask.sessionId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
      toolMetadata: null,
      truncated: message.truncated,
    })),
    since: context?.since ?? null,
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
    // A question asked since inbox slice G is an `asks` row; one asked before is a marker.
    const ask = await loadQuestionAsk(c.env, projectId, sessionId, markerId);
    if (ask) return c.json(await questionAskAttentionResponse(c, ask, membership.role, userId));
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

  // A question asked since inbox slice G is an `asks` row: one compare-and-set, then a durable
  // prompt (`services/inbox/question-asks.ts`). One asked before is still a marker, below.
  const ask = await loadQuestionAsk(env, projectId, sessionId, markerId);
  if (ask) {
    return answerQuestionAsk(env, { ask, answer, userId, authorization: { writer, wake } });
  }

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

/**
 * Archive a question still held as an attention marker: resolve it with reason `archived` and
 * tell no one. Archive leaves the agent where it is; a person who wants the agent to act answers
 * or writes in the chat instead (Raphaël, 2026-11-17, revising spec decision 4 of idea
 * 01M7G03ZCQ6TM6CMEYDRKQ8ST9). It shares the answer claim, so an answer and an archive cannot
 * both win; an archive claim left staged by an earlier build is completed here.
 */
export async function archiveAttention(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  markerId: string,
  hold: ArchiveCheckinHold
): Promise<{ agentNotified: boolean }> {
  const db = drizzle(env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');
  const writer = await requireSessionWriter(env, projectId, sessionId, userId, {
    db,
    action: 'archive the agent question in this session',
  });
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
  // `ready` (this request claimed it) and `in_flight` (an archive claim already staged) both end
  // in the same resolution. An `in_flight` claim is usually one an earlier build left stranded
  // when its archive prompt's outcome was unknown, so completing it unsticks the item. An
  // earlier build still sending at this moment (a rolling deploy) may tell the agent anyway,
  // which is the pre-change behaviour; the claim carries no owner or time to tell the two apart.
  const ownsClaim = prepared.status === 'ready';
  try {
    await projectDataService.completeAttentionArchive(env, projectId, sessionId, markerId);
  } catch (cause) {
    // Release only a claim this request staged: nothing was sent, and a staged claim would block
    // every answer. A claim found already staged may belong to a request still in progress.
    if (ownsClaim)
      await projectDataService.releaseAttentionArchive(env, projectId, sessionId, markerId);
    throw cause;
  }
  // The resolved marker no longer keeps SAM's check-ins off this chat; hold them until the
  // person writes in it, so archiving does not nudge the agent.
  await announceQuestionArchived(env, { projectId, sessionId, askId: markerId, ...hold });
  await recordSharedSessionAnswer(env, writer, { markerId, archived: true });
  return { agentNotified: false };
}

/**
 * Archive a pending ACP interaction (a permission, form or link request) from the inbox: its
 * inbox marker resolves with reason `archived` and nothing is answered, so the agent is told
 * nothing and stays where it is (Raphaël, 2026-11-17: every inbox kind archives silently). The
 * interaction stays pending in its chat, where the person can still answer it, until the runtime
 * gives up on it. The marker is projected once per interaction
 * (`projectInteractionAttention`), so it does not come back.
 */
export async function archiveInteractionAttention(
  env: Env,
  userId: string,
  projectId: string,
  sessionId: string,
  markerId: string
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');
  await requireSessionWriter(env, projectId, sessionId, userId, {
    db,
    action: 'archive the agent request in this session',
  });
  // Bound to this chat and to a pending interaction marker before anything is written.
  const { marker } = await loadAttentionForViewer(env, projectId, sessionId, markerId, userId);
  if (!marker || marker.source !== ACP_INTERACTION_ATTENTION_SOURCE)
    throw markRejectedBeforeEffects(errors.notFound('Attention request'));
  if (marker.resolvedAt !== null)
    throw markRejectedBeforeEffects(errors.conflict('Attention request is already resolved'));
  const resolved = await projectDataService.archiveInteractionMarker(env, projectId, markerId);
  if (resolved === 0) throw errors.conflict('Attention request is already resolved');
}
