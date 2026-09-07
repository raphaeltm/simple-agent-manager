import { type WorkspaceStatus } from '@simple-agent-manager/shared';
import { and, desc, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { toWorkspaceResponse } from '../../lib/mappers';
import { getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  jsonValidator,
  UpdateWorkspacePortsPublicSchema,
  UpdateWorkspaceSchema,
} from '../../schemas';
import { signPortAccessToken } from '../../services/jwt';
import {
  getWorkspacePortsOnNode,
  NodeAgentFetchError,
  NodeAgentHttpError,
} from '../../services/node-agent';
import { cleanupWorkspaceForDeletion } from '../../services/workspace-cleanup';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import { getOwnedWorkspace } from './_helpers';
import {
  isExpectedWorkspacePortsUpstreamUnavailable,
  workspacePortsReadinessPayload,
  workspacePortsReadinessStatus,
  workspacePortsStateForStatus,
} from './ports-readiness';
import { registerWorkspaceCreateRoute } from './workspace-create';

const crudRoutes = new Hono<{ Bindings: Env }>();

// Auth applied per-route (NOT via use('/*', ...)) to prevent middleware leakage
// to other subrouters (lifecycle, runtime) mounted at the same base path.
// See docs/notes/2026-03-12-callback-auth-middleware-leak-postmortem.md

crudRoutes.get('/', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const status = c.req.query('status');
  const nodeId = c.req.query('nodeId');
  const projectId = c.req.query('projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  // Build WHERE conditions in SQL instead of filtering in memory (P1 fix).
  const conditions = [eq(schema.workspaces.userId, userId)];
  if (status) {
    conditions.push(eq(schema.workspaces.status, status));
  } else {
    // Exclude deleted workspaces by default unless explicitly requested
    conditions.push(ne(schema.workspaces.status, 'deleted'));
  }
  if (nodeId) {
    conditions.push(eq(schema.workspaces.nodeId, nodeId));
  }
  if (projectId) {
    conditions.push(eq(schema.workspaces.projectId, projectId));
  }

  const rows = await db
    .select({ workspace: schema.workspaces, node: schema.nodes })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(and(...conditions))
    .orderBy(desc(schema.workspaces.createdAt));

  return c.json(
    rows.map(({ workspace, node }) => toWorkspaceResponse(workspace, c.env.BASE_DOMAIN, node))
  );
});

crudRoutes.get('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  const [node] = workspace.nodeId
    ? await db.select().from(schema.nodes).where(eq(schema.nodes.id, workspace.nodeId)).limit(1)
    : [];
  const response = toWorkspaceResponse(workspace, c.env.BASE_DOMAIN, node);

  if (workspace.status === 'creating') {
    const { getBootLogs } = await import('../../services/boot-log');
    response.bootLogs = await getBootLogs(c.env.KV, workspace.id);
  }

  return c.json(response);
});

crudRoutes.get('/:id/port-access', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const portParam = c.req.query('port');
  if (!portParam || !/^\d+$/.test(portParam)) {
    throw errors.badRequest('port query parameter is required and must be a number');
  }
  const port = parseInt(portParam, 10);
  if (port < 1 || port > 65535) {
    throw errors.badRequest('port must be between 1 and 65535');
  }

  const db = drizzle(c.env.DATABASE, { schema });
  // Verify ownership
  await getOwnedWorkspace(db, workspaceId, userId);

  const token = await signPortAccessToken(userId, workspaceId, port, c.env);
  const portUrl = `https://ws-${workspaceId.toLowerCase()}--${port}.${c.env.BASE_DOMAIN}/?port_token=${encodeURIComponent(token)}`;

  // Return JSON when client prefers it (CLI), redirect otherwise (browser)
  const accept = c.req.header('Accept') ?? '';
  if (accept.includes('application/json')) {
    return c.json({ token, url: portUrl, port });
  }
  return c.redirect(portUrl, 302);
});

crudRoutes.get('/:id/ports', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const [workspace] = await db
    .select()
    .from(schema.workspaces)
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);
  if (!workspace) {
    return c.json(workspacePortsReadinessPayload('gone', null, 'Workspace not found', false));
  }

  const workspaceStatus = workspace.status as WorkspaceStatus;
  if (workspaceStatus !== 'running' && workspaceStatus !== 'recovery') {
    const state = workspacePortsStateForStatus(workspaceStatus);
    return c.json(
      workspacePortsReadinessPayload(
        state,
        workspaceStatus,
        `Workspace is ${workspaceStatus}`,
        state === 'not_ready'
      ),
      workspacePortsReadinessStatus(state)
    );
  }

  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no node assigned');
  }

  let result: unknown;
  try {
    result = await getWorkspacePortsOnNode(workspace.nodeId, workspaceId, c.env, userId);
  } catch (err) {
    if (
      err instanceof NodeAgentHttpError &&
      isExpectedWorkspacePortsUpstreamUnavailable(err.statusCode)
    ) {
      return c.json(
        workspacePortsReadinessPayload(
          'not_ready',
          workspaceStatus,
          'Workspace ports are not ready',
          true,
          { upstreamStatus: err.statusCode }
        ),
        202
      );
    }
    if (err instanceof NodeAgentFetchError) {
      return c.json(
        workspacePortsReadinessPayload(
          'not_ready',
          workspaceStatus,
          'Workspace ports are not ready',
          true,
          { reason: 'fetch_exception' }
        ),
        202
      );
    }
    throw err;
  }
  return c.json(result);
});

crudRoutes.patch(
  '/:id/ports-public',
  requireAuth(),
  requireApproved(),
  jsonValidator(UpdateWorkspacePortsPublicSchema),
  async (c) => {
    const userId = getUserId(c);
    const workspaceId = c.req.param('id');
    const body = c.req.valid('json');
    const db = drizzle(c.env.DATABASE, { schema });

    await getOwnedWorkspace(db, workspaceId, userId);

    const [updated] = await db
      .update(schema.workspaces)
      .set({
        portsPublicEnabled: body.enabled,
        updatedAt: new Date().toISOString(),
      })
      .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
      .returning();

    if (!updated) {
      throw errors.notFound('Workspace not found');
    }

    return c.json(toWorkspaceResponse(updated, c.env.BASE_DOMAIN));
  }
);

crudRoutes.patch(
  '/:id',
  requireAuth(),
  requireApproved(),
  jsonValidator(UpdateWorkspaceSchema),
  async (c) => {
    const userId = getUserId(c);
    const workspaceId = c.req.param('id');
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');

    if (!body.displayName?.trim()) {
      throw errors.badRequest('displayName is required');
    }

    const workspace = await getOwnedWorkspace(db, workspaceId, userId);
    const nodeScopeId = workspace.nodeId ?? workspace.id;
    const uniqueName = await resolveUniqueWorkspaceDisplayName(
      db,
      nodeScopeId,
      body.displayName,
      workspace.id
    );

    await db
      .update(schema.workspaces)
      .set({
        nodeId: nodeScopeId,
        displayName: uniqueName.displayName,
        normalizedDisplayName: uniqueName.normalizedDisplayName,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.workspaces.id, workspace.id));

    const updated = await getOwnedWorkspace(db, workspace.id, userId);
    return c.json(toWorkspaceResponse(updated, c.env.BASE_DOMAIN));
  }
);

registerWorkspaceCreateRoute(crudRoutes);

crudRoutes.delete('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId, { includeDeleted: true });

  const deletion = await cleanupWorkspaceForDeletion({
    db,
    env: c.env,
    workspace,
    userId,
  });

  if (deletion.status === 'fenced' || deletion.status === 'superseded') {
    return c.json(
      {
        success: false,
        deletionStatus: 'rejected',
        workspaceStatus: 'unchanged',
        reason: deletion.reason,
      },
      409
    );
  }

  if (deletion.status === 'retry') {
    return c.json(
      {
        success: true,
        deletionStatus: 'pending',
        workspaceStatus: 'stopping',
        reason: deletion.reason,
      },
      202
    );
  }

  return c.json({ success: true, deletionStatus: 'confirmed' });
});

export { crudRoutes };
