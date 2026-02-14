import { Hono } from 'hono';
import type { Context } from 'hono';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { CreateNodeRequest, NodeHealthStatus, NodeResponse } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE } from '@simple-agent-manager/shared';
import type { Env } from '../index';
import { getUserId, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import * as schema from '../db/schema';
import { getRuntimeLimits } from '../services/limits';
import { createNodeRecord, deleteNodeResources, provisionNode, stopNodeResources } from '../services/nodes';
import { signCallbackToken, signNodeManagementToken, verifyCallbackToken } from '../services/jwt';
import { recordNodeRoutingMetric } from '../services/telemetry';
import {
  createWorkspaceOnNode,
  listNodeEventsOnNode,
  stopWorkspaceOnNode,
} from '../services/node-agent';

const nodesRoutes = new Hono<{ Bindings: Env }>();

nodesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  if (path.endsWith('/ready') || path.endsWith('/heartbeat') || path.endsWith('/errors')) {
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

/**
 * GET /:id/events — Proxy node events from the VM Agent.
 * Node events are proxied through the control plane because vm-* DNS records are
 * DNS-only (no Cloudflare SSL termination), so the browser cannot reach them directly
 * from an HTTPS page. Workspace events use ws-{id} subdomains which ARE Cloudflare-proxied.
 */
nodesRoutes.get('/:id/events', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ events: [], nextCursor: null });
  }

  const limit = Math.min(Math.max(Number(c.req.query('limit')) || 100, 1), 500);

  try {
    const result = await listNodeEventsOnNode(nodeId, c.env, userId, limit);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return empty rather than 500
    return c.json({ events: [], nextCursor: null });
  }
});

/**
 * POST /:id/token — Issue a node-scoped management token for direct VM Agent access.
 * The browser uses this token to call the VM Agent directly for node-level data
 * (events, health, etc.) without proxying through the control plane.
 */
nodesRoutes.post('/:id/token', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    throw errors.badRequest(`Node is not running (status: ${node.status})`);
  }

  const { token, expiresAt } = await signNodeManagementToken(userId, nodeId, null, c.env);
  const nodeAgentUrl = `https://vm-${nodeId.toLowerCase()}.${c.env.BASE_DOMAIN}:8080`;

  return c.json({ token, expiresAt, nodeAgentUrl });
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

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      const pendingWorkspaces = await innerDb
        .select({
          id: schema.workspaces.id,
          userId: schema.workspaces.userId,
          repository: schema.workspaces.repository,
          branch: schema.workspaces.branch,
        })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.nodeId, nodeId),
            eq(schema.workspaces.status, 'creating')
          )
        );

      for (const workspace of pendingWorkspaces) {
        try {
          const callbackToken = await signCallbackToken(workspace.id, c.env);
          await createWorkspaceOnNode(nodeId, c.env, workspace.userId, {
            workspaceId: workspace.id,
            repository: workspace.repository,
            branch: workspace.branch,
            callbackToken,
          });
        } catch (err) {
          await innerDb
            .update(schema.workspaces)
            .set({
              status: 'error',
              errorMessage:
                err instanceof Error ? err.message : 'Failed to dispatch workspace provisioning',
              updatedAt: new Date().toISOString(),
            })
            .where(eq(schema.workspaces.id, workspace.id));
        }
      }
    })()
  );

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

/** Default max body size for VM agent error reports: 32 KB */
const DEFAULT_MAX_VM_ERROR_BODY_BYTES = 32_768;

/** Default max batch size for VM agent error reports */
const DEFAULT_MAX_VM_ERROR_BATCH_SIZE = 10;

/** Truncation limits for VM agent error string fields */
const MAX_VM_ERROR_MESSAGE_LENGTH = 2048;
const MAX_VM_ERROR_SOURCE_LENGTH = 256;
const MAX_VM_ERROR_STACK_LENGTH = 4096;

const VALID_VM_ERROR_LEVELS = new Set(['error', 'warn']);

function truncateString(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) + '...' : value;
}

/**
 * POST /:id/errors
 *
 * Accepts a batch of VM agent error entries and logs each to
 * Workers observability via console.error(). Uses callback JWT auth
 * (same as heartbeat/ready). Returns 204.
 *
 * Body: { errors: VMAgentErrorEntry[] }
 */
nodesRoutes.post('/:id/errors', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);

  const maxBodyBytes = parseInt(
    c.env.MAX_VM_AGENT_ERROR_BODY_BYTES || String(DEFAULT_MAX_VM_ERROR_BODY_BYTES),
    10
  );
  const maxBatchSize = parseInt(
    c.env.MAX_VM_AGENT_ERROR_BATCH_SIZE || String(DEFAULT_MAX_VM_ERROR_BATCH_SIZE),
    10
  );

  // Check Content-Length before reading body
  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
  if (contentLength > maxBodyBytes) {
    throw errors.badRequest(`Request body too large (max ${maxBodyBytes} bytes)`);
  }

  // Parse JSON body
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Invalid JSON body');
  }

  // Validate structure
  if (!body || typeof body !== 'object' || !('errors' in body)) {
    throw errors.badRequest('Body must contain an "errors" array');
  }

  const { errors: entries } = body as { errors: unknown };

  if (!Array.isArray(entries)) {
    throw errors.badRequest('"errors" must be an array');
  }

  if (entries.length === 0) {
    return c.body(null, 204);
  }

  if (entries.length > maxBatchSize) {
    throw errors.badRequest(`Batch too large (max ${maxBatchSize} entries)`);
  }

  // Log each entry individually for CF observability searchability
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;

    const e = entry as Record<string, unknown>;

    // Validate required fields
    const message = typeof e.message === 'string' ? e.message : null;
    const source = typeof e.source === 'string' ? e.source : null;

    if (!message || !source) continue; // Skip malformed entries

    const level = typeof e.level === 'string' && VALID_VM_ERROR_LEVELS.has(e.level)
      ? e.level
      : 'error';

    console.error('[vm-agent-error]', {
      level,
      message: truncateString(message, MAX_VM_ERROR_MESSAGE_LENGTH),
      source: truncateString(source, MAX_VM_ERROR_SOURCE_LENGTH),
      stack: typeof e.stack === 'string' ? truncateString(e.stack, MAX_VM_ERROR_STACK_LENGTH) : null,
      workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
      context: e.context && typeof e.context === 'object' ? e.context : null,
      nodeId,
    });
  }

  return c.body(null, 204);
});

export { nodesRoutes };
