import {
  AcpInteractionBrowserAnswerSchema,
  AcpInteractionIdSchema,
} from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import type { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { getTrustedApiOrigin } from '../lib/trusted-origins';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas';
import {
  deliverAcpInteractionAnswer,
  resolveAcpInteractionDeliveryTarget,
} from '../services/acp-interaction-delivery';
import {
  answerInteraction,
  getInteractionDetail,
  recordInteractionDelivery,
  snapshotInteractions,
} from '../services/acp-interaction-store';
import { requireSessionCreator } from './chat-session-ownership';

function exactAppOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const apiOrigin = getTrustedApiOrigin(env);
  const url = new URL(apiOrigin);
  if (url.hostname.startsWith('api.')) url.hostname = `app.${url.hostname.slice(4)}`;
  return url.toString().replace(/\/$/u, '');
}

function requiredParam(value: string | undefined, name: string): string {
  if (!value) throw errors.badRequest(`${name} is required`);
  return value;
}

function requireExactBrowserOrigin(c: {
  req: { header: (name: string) => string | undefined };
  env: Env;
}): void {
  const origin = c.req.header('Origin');
  const fetchSite = c.req.header('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    throw errors.forbidden('Cross-site interaction writes are not allowed');
  }
  if (!origin || origin !== exactAppOrigin(c.env)) {
    throw errors.forbidden('Untrusted interaction write origin');
  }
}

export function registerChatAcpInteractionRoutes(chatRoutes: Hono<{ Bindings: Env }>): void {
  chatRoutes.get('/:sessionId/interactions', async (c) => {
    const userId = getUserId(c);
    const projectId = requiredParam(c.req.param('projectId'), 'projectId');
    const sessionId = requiredParam(c.req.param('sessionId'), 'sessionId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:read');
    const session = await requireSessionCreator(c.env, projectId, sessionId, userId).catch(
      () => null
    );
    const snapshot = await snapshotInteractions(
      c.env,
      projectId,
      sessionId,
      c.req.query('cursor') ?? null
    );
    if (session) return c.json(snapshot);
    return c.json({
      pending: snapshot.pending.map((item) => ({
        interactionId: item.interactionId,
        kind: item.kind,
        state: item.state,
        createdAt: item.createdAt,
        deadlineAt: item.deadlineAt,
      })),
      settled: [],
      cursor: null,
    });
  });

  chatRoutes.get('/:sessionId/interactions/:interactionId', async (c) => {
    const userId = getUserId(c);
    const projectId = requiredParam(c.req.param('projectId'), 'projectId');
    const sessionId = requiredParam(c.req.param('sessionId'), 'sessionId');
    const interactionId = v.parse(AcpInteractionIdSchema, c.req.param('interactionId'));
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:read');
    await requireSessionCreator(c.env, projectId, sessionId, userId);
    const detail = await getInteractionDetail(c.env, projectId, sessionId, interactionId);
    if (!detail) throw errors.notFound('ACP interaction');
    c.header('Cache-Control', 'private, no-store');
    return c.json(detail);
  });

  chatRoutes.post(
    '/:sessionId/interactions/:interactionId/answer',
    jsonValidator(AcpInteractionBrowserAnswerSchema),
    async (c) => {
      requireExactBrowserOrigin(c);
      const userId = getUserId(c);
      const projectId = requiredParam(c.req.param('projectId'), 'projectId');
      const sessionId = requiredParam(c.req.param('sessionId'), 'sessionId');
      const interactionId = v.parse(AcpInteractionIdSchema, c.req.param('interactionId'));
      const body = c.req.valid('json');
      const db = drizzle(c.env.DATABASE, { schema });

      await requireProjectCapability(db, projectId, userId, 'task:write');
      await requireSessionCreator(c.env, projectId, sessionId, userId);
      const answer = await answerInteraction(c.env, {
        projectId,
        chatSessionId: sessionId,
        interactionId,
        answerKey: body.answerKey,
        answerBodyHash: body.decision.answerHash,
        decision: body.decision,
      });
      if (answer.status !== 'answered' && answer.status !== 'already_answered') {
        if (answer.status === 'not_found') throw errors.notFound('ACP interaction');
        if (answer.status === 'conflict' || answer.status === 'answer_key_conflict') {
          throw errors.conflict(answer.reason);
        }
        if (answer.status === 'stale') throw errors.conflict(answer.reason);
        throw errors.badRequest(
          'reason' in answer ? answer.reason : 'Interaction answer was not accepted'
        );
      }

      const acceptedAnswer = answer;
      if (acceptedAnswer.status === 'answered') {
        const target = await resolveAcpInteractionDeliveryTarget(c.env, projectId, sessionId);
        if (target.status === 'ready') {
          const delivery = await deliverAcpInteractionAnswer(c.env, target.target, {
            interactionId,
            generation: acceptedAnswer.delivery.generation,
            runtimeIdentity: acceptedAnswer.delivery.runtimeIdentity,
            decision: body.decision,
          });
          await recordInteractionDelivery(
            c.env,
            projectId,
            sessionId,
            interactionId,
            delivery.outcome,
            'reason' in delivery ? delivery.reason : null
          );
        } else if (target.status === 'interrupted') {
          await recordInteractionDelivery(
            c.env,
            projectId,
            sessionId,
            interactionId,
            'interrupted',
            target.reason
          );
        }
      }

      return c.json({ accepted: true, state: acceptedAnswer.summary.state });
    }
  );
}
