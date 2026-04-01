import type {
  AgentSession,
} from '@simple-agent-manager/shared';
import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { toAgentSessionResponse } from '../../lib/mappers';
import { parsePositiveInt } from '../../lib/route-helpers';
import { ulid } from '../../lib/ulid';
import { getUserId, requireApproved,requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { CreateAgentSessionSchema, jsonValidator, UpdateAgentSessionSchema } from '../../schemas';
import { getRuntimeLimits } from '../../services/limits';
import {
  createAgentSessionOnNode,
  resumeAgentSessionOnNode,
  stopAgentSessionOnNode,
  suspendAgentSessionOnNode,
} from '../../services/node-agent';
import { assertNodeOperational,getOwnedNode, getOwnedWorkspace } from './_helpers';

const agentSessionRoutes = new Hono<{ Bindings: Env }>();

// Auth applied per-route (NOT via use('/*', ...)) to prevent middleware leakage
// to other subrouters (lifecycle, runtime) mounted at the same base path.
// See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md

agentSessionRoutes.get('/:id/agent-sessions', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    return c.json([] as AgentSession[]);
  }

  const sessions = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt));

  return c.json(sessions.map(toAgentSessionResponse));
});

agentSessionRoutes.post('/:id/agent-sessions', requireAuth(), requireApproved(), jsonValidator(CreateAgentSessionSchema), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const node = await getOwnedNode(db, workspace.nodeId, userId);
  assertNodeOperational(node, 'create agent session');

  const existingRunning = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId),
        eq(schema.agentSessions.status, 'running')
      )
    );

  if (existingRunning.length >= limits.maxAgentSessionsPerWorkspace) {
    throw errors.badRequest(
      `Maximum ${limits.maxAgentSessionsPerWorkspace} agent sessions per workspace`
    );
  }

  const sessionId = ulid();
  const now = new Date().toISOString();

  await db.insert(schema.agentSessions).values({
    id: sessionId,
    workspaceId: workspace.id,
    userId,
    status: 'running',
    label: body.label?.trim() || null,
    agentType: body.agentType?.trim() || null,
    worktreePath: body.worktreePath?.trim() || null,
    createdAt: now,
    updatedAt: now,
  });

  try {
    await createAgentSessionOnNode(
      workspace.nodeId,
      workspace.id,
      sessionId,
      body.label?.trim() || null,
      c.env,
      userId,
      workspace.chatSessionId,
      workspace.projectId,
    );
  } catch (err) {
    await db
      .update(schema.agentSessions)
      .set({
        status: 'error',
        errorMessage: err instanceof Error ? err.message : 'Failed to create agent session',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.agentSessions.id, sessionId));

    throw errors.internal('Failed to create agent session on node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.id, sessionId))
    .limit(1);

  return c.json(toAgentSessionResponse(rows[0]!), 201);
});

agentSessionRoutes.patch('/:id/agent-sessions/:sessionId', requireAuth(), requireApproved(), jsonValidator(UpdateAgentSessionSchema), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  const body = c.req.valid('json');
  const maxLabelLength = parsePositiveInt(c.env.MAX_AGENT_SESSION_LABEL_LENGTH, 50);
  const label = body.label?.trim()?.slice(0, maxLabelLength);
  if (!label) {
    throw errors.badRequest('Label is required and must be non-empty');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  if (session.status !== 'running') {
    throw errors.badRequest('Cannot rename a session that is not running');
  }

  await db
    .update(schema.agentSessions)
    .set({
      label,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json(toAgentSessionResponse({ ...session, label, updatedAt: new Date().toISOString() }));
});

agentSessionRoutes.post('/:id/agent-sessions/:sessionId/stop', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  if (session.status !== 'running') {
    // Still attempt VM stop for orphaned sessions whose process may be alive
    if (workspace.nodeId) {
      try {
        await stopAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
      } catch (e) {
        log.error('agent_session.orphaned_stop_failed', { sessionId: session.id, workspaceId: workspace.id, nodeId: workspace.nodeId, error: String(e) });
      }
    }
    return c.json({ status: session.status });
  }

  try {
    await stopAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
  } catch (e) {
    log.error('agent_session.stop_on_node_failed', { sessionId: session.id, workspaceId: workspace.id, nodeId: workspace.nodeId, error: String(e) });
  }

  await db
    .update(schema.agentSessions)
    .set({
      status: 'stopped',
      stoppedAt: new Date().toISOString(),
      errorMessage: null,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json({ status: 'stopped' });
});

agentSessionRoutes.post('/:id/agent-sessions/:sessionId/suspend', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  if (session.status !== 'running' && session.status !== 'error') {
    throw errors.badRequest(`Session cannot be suspended from status: ${session.status}`);
  }

  try {
    await suspendAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
  } catch (e) {
    log.warn('agent_session.suspend_on_node_failed', { sessionId: session.id, workspaceId: workspace.id, nodeId: workspace.nodeId, error: String(e) });
  }

  const now = new Date().toISOString();
  await db
    .update(schema.agentSessions)
    .set({
      status: 'suspended',
      suspendedAt: now,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json(
    toAgentSessionResponse({
      ...session,
      status: 'suspended',
      suspendedAt: now,
      errorMessage: null,
      updatedAt: now,
    })
  );
});

agentSessionRoutes.post('/:id/agent-sessions/:sessionId/resume', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const sessionId = c.req.param('sessionId');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace is not attached to a node');
  }

  const rows = await db
    .select()
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.id, sessionId),
        eq(schema.agentSessions.workspaceId, workspace.id),
        eq(schema.agentSessions.userId, userId)
      )
    )
    .limit(1);

  const session = rows[0];
  if (!session) {
    throw errors.notFound('Agent session');
  }

  // Already running -- idempotent
  if (session.status === 'running') {
    return c.json(toAgentSessionResponse(session));
  }

  // Resume is allowed from suspended, stopped, or error states.
  // For suspended sessions, also tell the VM agent to resume.
  if (session.status === 'suspended') {
    try {
      await resumeAgentSessionOnNode(workspace.nodeId, workspace.id, session.id, c.env, userId);
    } catch (e) {
      log.warn('agent_session.resume_on_node_failed', { sessionId: session.id, workspaceId: workspace.id, nodeId: workspace.nodeId, error: String(e) });
    }
  }

  const now = new Date().toISOString();
  await db
    .update(schema.agentSessions)
    .set({
      status: 'running',
      stoppedAt: null,
      suspendedAt: null,
      errorMessage: null,
      updatedAt: now,
    })
    .where(eq(schema.agentSessions.id, session.id));

  return c.json(
    toAgentSessionResponse({
      ...session,
      status: 'running',
      stoppedAt: null,
      suspendedAt: null,
      errorMessage: null,
      updatedAt: now,
    })
  );
});

export { agentSessionRoutes };
