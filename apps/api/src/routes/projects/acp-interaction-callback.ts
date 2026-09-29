import {
  AcpInteractionRuntimeCreateSchema,
  AcpInteractionRuntimeSettleSchema,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { jsonValidator } from '../../schemas';
import { createInteraction, settleInteraction } from '../../services/acp-interaction-store';
import { verifyCallbackToken } from '../../services/jwt';

const acpInteractionCallbackRoute = new Hono<{ Bindings: Env }>();

interface VerifiedWorkspaceIdentity {
  projectId: string;
  workspaceId: string;
  chatSessionId: string;
  userId: string;
  status: string;
}

async function verifyWorkspaceCallback(c: {
  env: Env;
  req: { header: (name: string) => string | undefined; param: (name: string) => string };
}): Promise<VerifiedWorkspaceIdentity> {
  const projectId = c.req.param('id');
  const workspaceId = c.req.param('workspaceId');
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env, { expectedScope: 'workspace' });
  if (payload.workspace !== workspaceId) {
    throw errors.unauthorized('Callback token does not match workspace');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  const row = await db
    .select({
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      userId: schema.workspaces.userId,
      status: schema.workspaces.status,
    })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .get();
  if (!row || row.projectId !== projectId || !row.chatSessionId) {
    throw errors.notFound('Workspace');
  }
  const chatSessionId = row.chatSessionId;
  if (!['creating', 'running', 'recovery'].includes(row.status)) {
    throw errors.gone(`Workspace is ${row.status}`);
  }
  return {
    projectId,
    workspaceId,
    chatSessionId,
    userId: row.userId,
    status: row.status,
  };
}

async function assertAgentSessionCurrent(env: Env, workspaceId: string, agentSessionId: string) {
  const row = await env.DATABASE.prepare(
    `SELECT id, status FROM agent_sessions WHERE id = ? AND workspace_id = ? LIMIT 1`
  )
    .bind(agentSessionId, workspaceId)
    .first<{ id: string; status: string }>();
  if (!row) throw errors.notFound('Agent session');
  if (row.status !== 'running') throw errors.conflict(`Agent session is ${row.status}`);
}

/**
 * VM-agent ACP interaction callbacks. Mounted before projectsRoutes because it
 * uses workspace callback JWT Bearer auth, not browser session cookies.
 */
acpInteractionCallbackRoute.post(
  '/:id/workspaces/:workspaceId/acp-interactions',
  jsonValidator(AcpInteractionRuntimeCreateSchema),
  async (c) => {
    const identity = await verifyWorkspaceCallback(c);
    const body = c.req.valid('json');
    await assertAgentSessionCurrent(c.env, identity.workspaceId, body.agentSessionId);
    const result = await createInteraction(c.env, {
      ...body,
      projectId: identity.projectId,
      chatSessionId: identity.chatSessionId,
    });
    if (result.status === 'created' || result.status === 'existing') {
      log.info('acp_interaction.created', {
        projectId: identity.projectId,
        chatSessionId: identity.chatSessionId,
        interactionId: body.interactionId,
        kind: body.kind,
        state: result.summary.state,
      });
      return c.json(result, result.status === 'created' ? 201 : 200);
    }
    if (result.status === 'disabled') return c.json(result, 409);
    if (result.status === 'conflict') return c.json(result, 409);
    if (result.status === 'too_many_pending') return c.json(result, 429);
    return c.json(result, 400);
  }
);

acpInteractionCallbackRoute.post(
  '/:id/workspaces/:workspaceId/acp-interactions/:interactionId/settle',
  jsonValidator(AcpInteractionRuntimeSettleSchema),
  async (c) => {
    const identity = await verifyWorkspaceCallback(c);
    const body = c.req.valid('json');
    if (body.interactionId !== c.req.param('interactionId')) {
      throw errors.badRequest('interactionId route/body mismatch');
    }
    await assertAgentSessionCurrent(c.env, identity.workspaceId, body.agentSessionId);
    const result = await settleInteraction(c.env, {
      ...body,
      projectId: identity.projectId,
      chatSessionId: identity.chatSessionId,
    });
    return c.json(
      result,
      result.status === 'not_found' ? 404 : result.status === 'stale' ? 409 : 200
    );
  }
);

export { acpInteractionCallbackRoute };
