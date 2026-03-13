import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type {
  AcpSessionStatus,
  AcpSessionForkRequest,
  AcpSessionAssignRequest,
  AcpSessionStatusReport,
  AcpSessionHeartbeatRequest,
} from '@simple-agent-manager/shared';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import * as projectDataService from '../../services/project-data';
import { parsePositiveInt } from '../../lib/route-helpers';

const acpSessionRoutes = new Hono<{ Bindings: Env }>();

/** POST /:id/acp-sessions — Create a new ACP session */
acpSessionRoutes.post('/:id/acp-sessions', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<{
    chatSessionId: string;
    initialPrompt?: string;
    agentType?: string;
  }>();

  if (!body.chatSessionId) {
    throw errors.badRequest('chatSessionId is required');
  }

  // Validate initialPrompt length (256 KB default, configurable via MAX_ACP_PROMPT_BYTES)
  const maxPromptBytes = parsePositiveInt(c.env.MAX_ACP_PROMPT_BYTES as string, 262144);
  if (body.initialPrompt && new TextEncoder().encode(body.initialPrompt).length > maxPromptBytes) {
    throw errors.badRequest(`initialPrompt exceeds maximum size of ${maxPromptBytes} bytes`);
  }

  const session = await projectDataService.createAcpSession(
    c.env,
    projectId,
    body.chatSessionId,
    body.initialPrompt ?? null,
    body.agentType ?? null
  );

  return c.json(session, 201);
});

/** GET /:id/acp-sessions — List ACP sessions */
acpSessionRoutes.get('/:id/acp-sessions', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const status = c.req.query('status') as AcpSessionStatus | undefined;
  const chatSessionId = c.req.query('chatSessionId');
  const limit = parsePositiveInt(c.req.query('limit'), 50);
  const offset = parsePositiveInt(c.req.query('offset'), 0);

  const result = await projectDataService.listAcpSessions(c.env, projectId, {
    status,
    chatSessionId,
    limit,
    offset,
  });

  return c.json(result);
});

/** GET /:id/acp-sessions/:sessionId — Get a single ACP session */
acpSessionRoutes.get('/:id/acp-sessions/:sessionId', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const session = await projectDataService.getAcpSession(c.env, projectId, sessionId);
  if (!session) {
    throw errors.notFound('ACP session not found');
  }

  return c.json(session);
});

/** POST /:id/acp-sessions/:sessionId/assign — Assign workspace + node to session */
acpSessionRoutes.post('/:id/acp-sessions/:sessionId/assign', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<AcpSessionAssignRequest>();
  if (!body.workspaceId || !body.nodeId) {
    throw errors.badRequest('workspaceId and nodeId are required');
  }

  // US3: Validate workspace belongs to this project
  const workspace = await db.query.workspaces.findFirst({
    where: eq(schema.workspaces.id, body.workspaceId),
  });
  if (!workspace) {
    throw errors.notFound('Workspace not found');
  }
  if (workspace.projectId !== projectId) {
    throw errors.badRequest(
      `Workspace ${body.workspaceId} belongs to project ${workspace.projectId ?? 'none'}, not ${projectId}`
    );
  }

  const session = await projectDataService.transitionAcpSession(
    c.env,
    projectId,
    sessionId,
    'assigned',
    {
      actorType: 'system',
      actorId: userId,
      reason: 'Workspace assigned',
      workspaceId: body.workspaceId,
      nodeId: body.nodeId,
    }
  );

  return c.json(session);
});

/**
 * POST /:id/acp-sessions/:sessionId/status — VM agent reports status change.
 *
 * Auth model: JWT auth via requireAuth() middleware (applied at index level) + nodeId verification
 * in the DO (rejects if body.nodeId doesn't match session's assigned node).
 * We don't use requireOwnedProject because the VM agent authenticates as the
 * workspace owner, not necessarily the project owner, and the nodeId check
 * provides identity verification at the session level.
 */
acpSessionRoutes.post('/:id/acp-sessions/:sessionId/status', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const body = await c.req.json<AcpSessionStatusReport>();
  if (!body.status || !body.nodeId) {
    throw errors.badRequest('status and nodeId are required');
  }

  // Runtime allowlist — VM agents can only report these statuses
  const ALLOWED_REPORTED_STATUSES = ['running', 'completed', 'failed'] as const;
  if (!(ALLOWED_REPORTED_STATUSES as readonly string[]).includes(body.status)) {
    throw errors.badRequest('status must be running, completed, or failed');
  }

  if (body.status === 'running' && !body.acpSdkSessionId) {
    throw errors.badRequest('acpSdkSessionId is required when reporting running status');
  }

  // Validate node matches assigned node
  const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
  if (!existing) {
    throw errors.notFound('ACP session not found');
  }
  if (existing.nodeId !== body.nodeId) {
    console.error(JSON.stringify({
      event: 'acp_session.status_node_mismatch',
      sessionId,
      projectId,
      callerUserId: userId,
      expectedNodeId: existing.nodeId,
      receivedNodeId: body.nodeId,
      action: 'rejected',
    }));
    throw errors.forbidden('Node identity verification failed');
  }

  const session = await projectDataService.transitionAcpSession(
    c.env,
    projectId,
    sessionId,
    body.status,
    {
      actorType: 'vm-agent',
      actorId: body.nodeId,
      reason: body.status === 'failed' ? body.errorMessage : undefined,
      acpSdkSessionId: body.acpSdkSessionId,
      errorMessage: body.errorMessage,
    }
  );

  return c.json(session);
});

/**
 * POST /:id/acp-sessions/:sessionId/heartbeat — VM agent heartbeat.
 * Auth: JWT + nodeId verification in DO (same model as /status above).
 */
acpSessionRoutes.post('/:id/acp-sessions/:sessionId/heartbeat', async (c) => {
  const userId = getUserId(c); // Ensure authenticated (JWT validated by requireAuth middleware)
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const body = await c.req.json<AcpSessionHeartbeatRequest>();
  if (!body.nodeId) {
    throw errors.badRequest('nodeId is required');
  }

  // Validate node matches assigned node — prevents cross-user session manipulation.
  // See AUTH-VULN-05 in Shannon security assessment.
  const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
  if (!existing) {
    throw errors.notFound('ACP session');
  }
  if (existing.nodeId !== body.nodeId) {
    console.error(JSON.stringify({
      event: 'acp_session.heartbeat_node_mismatch',
      sessionId,
      projectId,
      callerUserId: userId,
      expectedNodeId: existing.nodeId,
      receivedNodeId: body.nodeId,
      action: 'rejected',
    }));
    throw errors.forbidden('Node identity verification failed');
  }

  await projectDataService.updateAcpSessionHeartbeat(c.env, projectId, sessionId, body.nodeId);
  return c.body(null, 204);
});

/** POST /:id/acp-sessions/:sessionId/fork — Fork a completed/interrupted session */
acpSessionRoutes.post('/:id/acp-sessions/:sessionId/fork', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const body = await c.req.json<AcpSessionForkRequest>();
  if (!body.contextSummary) {
    throw errors.badRequest('contextSummary is required');
  }

  // Validate contextSummary length (256 KB default, configurable via MAX_ACP_CONTEXT_BYTES)
  const maxContextBytes = parsePositiveInt(c.env.MAX_ACP_CONTEXT_BYTES as string, 262144);
  if (new TextEncoder().encode(body.contextSummary).length > maxContextBytes) {
    throw errors.badRequest(`contextSummary exceeds maximum size of ${maxContextBytes} bytes`);
  }

  const forked = await projectDataService.forkAcpSession(
    c.env,
    projectId,
    sessionId,
    body.contextSummary
  );

  return c.json(forked, 201);
});

/** GET /:id/acp-sessions/:sessionId/lineage — Get fork lineage tree */
acpSessionRoutes.get('/:id/acp-sessions/:sessionId/lineage', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireOwnedProject(db, projectId, userId);

  const sessions = await projectDataService.getAcpSessionLineage(c.env, projectId, sessionId);
  return c.json({ sessions });
});

export { acpSessionRoutes };
