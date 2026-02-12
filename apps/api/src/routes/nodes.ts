import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { CreateNodeRequest, Event, NodeHealthStatus, NodeResponse } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import * as schema from '../db/schema';
import { getRuntimeLimits } from '../services/limits';
import { createNodeRecord, deleteNodeResources, provisionNode, stopNodeResources } from '../services/nodes';
import { verifyCallbackToken } from '../services/jwt';
import { recordNodeRoutingMetric } from '../services/telemetry';
import { listNodeEvents as fetchNodeEvents, stopWorkspaceOnNode } from '../services/node-agent';

const nodesRoutes = new Hono<{ Bindings: Env }>();

nodesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  if (path.endsWith('/ready') || path.endsWith('/heartbeat')) {
    return next();
  }
  return requireAuth()(c, next);
});

function deriveHealthStatus(node: schema.Node, now: number): NodeHealthStatus {
  if (node.status !== 'running') {
    return (node.healthStatus as NodeHealthStatus) || 'stale';
  }

  if (!node.lastHeartbeatAt) {
    return 'stale';
  }

  const lastHeartbeat = Date.parse(node.lastHeartbeatAt);
  if (Number.isNaN(lastHeartbeat)) {
    return 'unhealthy';
  }

  const ageSeconds = Math.max(0, Math.floor((now - lastHeartbeat) / 1000));
  const staleThreshold = Math.max(1, node.heartbeatStaleAfterSeconds || 180);

  if (ageSeconds <= staleThreshold) {
    return 'healthy';
  }
  if (ageSeconds <= staleThreshold * 2) {
    return 'stale';
  }
  return 'unhealthy';
}

function toNodeResponse(node: schema.Node): NodeResponse {
  return {
    id: node.id,
    name: node.name,
    status: node.status as NodeResponse['status'],
    healthStatus: node.healthStatus as NodeResponse['healthStatus'],
    vmSize: node.vmSize as NodeResponse['vmSize'],
    vmLocation: node.vmLocation as NodeResponse['vmLocation'],
    ipAddress: node.ipAddress,
    lastHeartbeatAt: node.lastHeartbeatAt,
    heartbeatStaleAfterSeconds: node.heartbeatStaleAfterSeconds,
    errorMessage: node.errorMessage,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
}

async function verifyNodeCallbackAuth(c: Context<{ Bindings: Env }>, nodeId: string): Promise<void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    throw errors.unauthorized('Missing or invalid Authorization header');
  }

  const token = authHeader.slice(7);
  const payload = await verifyCallbackToken(token, c.env);
  if (payload.workspace !== nodeId) {
    throw errors.unauthorized('Callback token does not match node');
  }
}

async function refreshNodeHealth(
  db: ReturnType<typeof drizzle<typeof schema>>,
  node: schema.Node
): Promise<schema.Node> {
  const computedHealth = deriveHealthStatus(node, Date.now());
  if (computedHealth === node.healthStatus) {
    return node;
  }

  await db
    .update(schema.nodes)
    .set({
      healthStatus: computedHealth,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.nodes.id, node.id));

  return {
    ...node,
    healthStatus: computedHealth,
    updatedAt: new Date().toISOString(),
  };
}

nodesRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const nodes = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.userId, userId))
    .orderBy(desc(schema.nodes.createdAt));

  const hydrated = await Promise.all(nodes.map((node) => refreshNodeHealth(db, node)));
  return c.json(hydrated.map(toNodeResponse));
});

nodesRoutes.post('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = await c.req.json<CreateNodeRequest>();
  const limits = getRuntimeLimits(c.env);

  if (!body.name?.trim()) {
    throw errors.badRequest('Node name is required');
  }

  const existingNodes = await db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(eq(schema.nodes.userId, userId));

  if (existingNodes.length >= limits.maxNodesPerUser) {
    throw errors.badRequest(`Maximum ${limits.maxNodesPerUser} nodes allowed`);
  }

  const created = await createNodeRecord(c.env, {
    userId,
    name: body.name.trim(),
    vmSize: body.vmSize ?? DEFAULT_VM_SIZE,
    vmLocation: body.vmLocation ?? DEFAULT_VM_LOCATION,
    heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
  });

  recordNodeRoutingMetric({
    metric: 'sc_006_node_efficiency',
    nodeId: created.id,
    userId,
    reusedExistingNode: false,
    nodeCountForUser: existingNodes.length + 1,
  }, c.env);

  c.executionCtx.waitUntil(provisionNode(created.id, c.env));
  return c.json(created, 201);
});

nodesRoutes.get('/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const node = await requireNodeOwnership(c, c.req.param('id'));
  if (!node) {
    throw errors.notFound('Node');
  }

  const refreshed = await refreshNodeHealth(db, node);
  return c.json(toNodeResponse(refreshed));
});

nodesRoutes.post('/:id/stop', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  const workspaceRows = await db
    .select({ id: schema.workspaces.id, status: schema.workspaces.status })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  if (node.status === 'running' && node.healthStatus !== 'unhealthy') {
    for (const workspace of workspaceRows) {
      if (workspace.status === 'running' || workspace.status === 'creating') {
        try {
          await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId);
        } catch {
          // Best effort to stop children before node power-off.
        }
      }
    }
  }

  await stopNodeResources(nodeId, userId, c.env);

  const now = new Date().toISOString();
  const workspaceIds = workspaceRows.map((workspace) => workspace.id);
  if (workspaceIds.length > 0) {
    await db
      .update(schema.agentSessions)
      .set({
        status: 'stopped',
        stoppedAt: now,
        updatedAt: now,
      })
      .where(inArray(schema.agentSessions.workspaceId, workspaceIds));
  }

  return c.json({ status: 'stopped' });
});

nodesRoutes.delete('/:id', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  await deleteNodeResources(nodeId, userId, c.env);

  const workspaceRows = await db
    .select({ id: schema.workspaces.id })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  const workspaceIds = workspaceRows.map((workspace) => workspace.id);
  if (workspaceIds.length > 0) {
    await db
      .delete(schema.agentSessions)
      .where(inArray(schema.agentSessions.workspaceId, workspaceIds));
  }

  await db
    .delete(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.nodeId, nodeId),
        eq(schema.workspaces.userId, userId)
      )
    );

  await db
    .delete(schema.nodes)
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        eq(schema.nodes.userId, userId)
      )
    );

  return c.json({ success: true });
});

nodesRoutes.get('/:id/events', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const limit = Number.parseInt(c.req.query('limit') ?? '100', 10);
  const cursor = c.req.query('cursor');
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  try {
    const result = await fetchNodeEvents(nodeId, c.env, userId, limit, cursor) as {
      events?: Event[];
      nextCursor?: string | null;
    };

    return c.json({
      events: result.events ?? [],
      nextCursor: result.nextCursor ?? null,
    });
  } catch {
    return c.json({ events: [] as Event[], nextCursor: null });
  }
});

nodesRoutes.post('/:id/ready', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  await db
    .update(schema.nodes)
    .set({
      status: 'running',
      healthStatus: 'healthy',
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(schema.nodes.id, nodeId));

  return c.json({ status: 'running', readyAt: now });
});

nodesRoutes.post('/:id/heartbeat', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);
  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  await db
    .update(schema.nodes)
    .set({
      lastHeartbeatAt: now,
      healthStatus: 'healthy',
      updatedAt: now,
    })
    .where(eq(schema.nodes.id, nodeId));

  const rows = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw errors.notFound('Node');
  }

  return c.json({
    status: node.status,
    lastHeartbeatAt: now,
    healthStatus: 'healthy',
  });
});

export { nodesRoutes };
