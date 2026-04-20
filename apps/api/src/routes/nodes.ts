import type { NodeHealthStatus, NodeResponse } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE, getLocationsForProvider,isValidLocationForProvider } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { CreateNodeSchema, jsonValidator } from '../schemas';
import { signNodeManagementToken } from '../services/jwt';
import { getRuntimeLimits } from '../services/limits';
import {
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeEventsOnNode,
  nodeAgentRawRequest,
  stopWorkspaceOnNode,
} from '../services/node-agent';
import { createNodeRecord, deleteNodeResources, provisionNode, stopNodeResources } from '../services/nodes';
import { recordNodeRoutingMetric } from '../services/telemetry';

const nodesRoutes = new Hono<{ Bindings: Env }>();

// All node CRUD/observability routes require user auth.
// Lifecycle callbacks (ready, heartbeat, errors) are on nodeLifecycleRoutes
// and use callback JWT auth instead — but since both routers are mounted at
// /api/nodes, Hono's wildcard middleware here can match lifecycle paths too.
// We keep the skip to prevent auth middleware from blocking those requests.
nodesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  if (path.endsWith('/ready') || path.endsWith('/heartbeat') || path.endsWith('/errors')) {
    return next();
  }
  return requireAuth()(c, async () => {
    await requireApproved()(c, next);
  });
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
  let lastMetrics: NodeResponse['lastMetrics'] = null;
  if (node.lastMetrics) {
    try {
      lastMetrics = JSON.parse(node.lastMetrics);
    } catch {
      // Ignore malformed JSON in lastMetrics
    }
  }

  return {
    id: node.id,
    name: node.name,
    status: node.status as NodeResponse['status'],
    healthStatus: node.healthStatus as NodeResponse['healthStatus'],
    cloudProvider: (node.cloudProvider as NodeResponse['cloudProvider']) ?? null,
    vmSize: node.vmSize as NodeResponse['vmSize'],
    vmLocation: node.vmLocation as NodeResponse['vmLocation'],
    ipAddress: node.ipAddress,
    lastHeartbeatAt: node.lastHeartbeatAt,
    heartbeatStaleAfterSeconds: node.heartbeatStaleAfterSeconds,
    lastMetrics,
    errorMessage: node.errorMessage,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
  };
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
    .where(and(eq(schema.nodes.userId, userId), ne(schema.nodes.status, 'deleted')))
    .orderBy(desc(schema.nodes.createdAt));

  const hydrated = await Promise.all(nodes.map((node) => refreshNodeHealth(db, node)));
  return c.json(hydrated.map(toNodeResponse));
});

nodesRoutes.post('/', jsonValidator(CreateNodeSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);

  if (!body.name?.trim()) {
    throw errors.badRequest('Node name is required');
  }

  const existingNodes = await db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(and(eq(schema.nodes.userId, userId), ne(schema.nodes.status, 'deleted')));

  if (existingNodes.length >= limits.maxNodesPerUser) {
    throw errors.badRequest(`Maximum ${limits.maxNodesPerUser} nodes allowed`);
  }

  const provider = body.provider;
  const vmLocation = body.vmLocation ?? DEFAULT_VM_LOCATION;

  // Validate location against provider if provider is specified
  if (provider && !isValidLocationForProvider(provider, vmLocation)) {
    const validLocations = getLocationsForProvider(provider).map((l) => l.id);
    throw errors.badRequest(
      `Location '${vmLocation}' is not valid for provider '${provider}'. Valid locations: ${validLocations.join(', ')}`
    );
  }

  // Enforce compute quota when platform credentials will be used
  const { resolveCredentialSource } = await import('../services/provider-credentials');
  const credResult = await resolveCredentialSource(db, userId, provider ?? undefined);
  if (!credResult) {
    throw errors.forbidden('Cloud provider credentials required. Connect your account in Settings.');
  }
  if (credResult.credentialSource === 'platform' && c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false') {
    const { checkQuotaForUser } = await import('../services/compute-quotas');
    const quotaCheck = await checkQuotaForUser(db, userId);
    if (!quotaCheck.allowed) {
      throw errors.forbidden(
        `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
        'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
      );
    }
  }

  const created = await createNodeRecord(c.env, {
    userId,
    name: body.name.trim(),
    vmSize: body.vmSize ?? DEFAULT_VM_SIZE,
    vmLocation,
    cloudProvider: provider,
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
      if (workspace.status === 'running' || workspace.status === 'recovery' || workspace.status === 'creating') {
        try {
          await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId);
        } catch (e) {
          log.warn('node.workspace_stop_before_power_off_failed', { nodeId, workspaceId: workspace.id, error: String(e) });
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

  return c.json({ status: 'deleted' });
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
 * GET /:id/system-info — Proxy system info from the VM Agent.
 * Returns CPU, memory, disk, Docker, software versions, and agent info.
 * Only available when the node is running.
 */
nodesRoutes.get('/:id/system-info', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ error: 'NODE_NOT_RUNNING', message: 'System info unavailable when node is not running' }, 400);
  }

  try {
    const result = await getNodeSystemInfoFromNode(nodeId, c.env, userId);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return 503
    return c.json({ error: 'UNAVAILABLE', message: 'Could not reach node agent' }, 503);
  }
});

/**
 * GET /:id/logs — Proxy node logs from the VM Agent.
 * Passes through query params (source, level, container, since, until, search, cursor, limit)
 * to the VM Agent's /logs endpoint. Only available when the node is running.
 */
nodesRoutes.get('/:id/logs', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    return c.json({ entries: [], nextCursor: null, hasMore: false });
  }

  // Pass through all query params to the VM Agent
  const queryString = new URL(c.req.url).searchParams.toString();

  try {
    const result = await getNodeLogsFromNode(nodeId, c.env, userId, queryString);
    return c.json(result);
  } catch {
    // Node agent may be unreachable — return empty rather than 500
    return c.json({ entries: [], nextCursor: null, hasMore: false });
  }
});

/**
 * GET /:id/logs/stream — WebSocket proxy for real-time log streaming from the VM Agent.
 * Authenticates the user, verifies node ownership, signs a management JWT,
 * and proxies the WebSocket connection to the VM agent's /logs/stream endpoint.
 */
nodesRoutes.get('/:id/logs/stream', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }

  if (node.status !== 'running') {
    throw errors.badRequest(`Node is not running (status: ${node.status})`);
  }

  // Sign a management JWT for the VM agent
  const { token } = await signNodeManagementToken(userId, nodeId, null, c.env);

  // Build the VM agent WebSocket URL with all query params
  const clientUrl = new URL(c.req.url);
  const vmProtocol = c.env.VM_AGENT_PROTOCOL || 'https';
  const vmPort = c.env.VM_AGENT_PORT || '8443';
  const vmUrl = new URL(`${vmProtocol}://${nodeId.toLowerCase()}.vm.${c.env.BASE_DOMAIN}:${vmPort}/logs/stream`);
  vmUrl.searchParams.set('token', token);

  // Forward filter params from client
  for (const [key, value] of clientUrl.searchParams.entries()) {
    if (key !== 'token') {
      vmUrl.searchParams.set(key, value);
    }
  }

  // Proxy the WebSocket upgrade to the VM agent
  const headers = new Headers(c.req.raw.headers);
  headers.delete('x-sam-node-id');
  headers.set('X-SAM-Node-Id', nodeId);

  return fetch(vmUrl.toString(), {
    method: 'GET',
    headers,
  });
});

/**
 * GET /:id/events/export — Download the raw SQLite event database from the VM Agent.
 * Streams the binary file through to the browser as an attachment download.
 */
nodesRoutes.get('/:id/events/export', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/events/export', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/x-sqlite3',
        'Content-Disposition': response.headers.get('Content-Disposition') || `attachment; filename="events-${nodeId}.db"`,
        'Content-Length': response.headers.get('Content-Length') || '',
      },
    });
  } catch {
    throw errors.badRequest('Could not download events database — node agent may be unreachable');
  }
});

/**
 * GET /:id/metrics/export — Download the raw SQLite metrics database from the VM Agent.
 * Streams the binary file through to the browser as an attachment download.
 */
nodesRoutes.get('/:id/metrics/export', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/metrics/export', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/x-sqlite3',
        'Content-Disposition': response.headers.get('Content-Disposition') || `attachment; filename="metrics-${nodeId}.db"`,
        'Content-Length': response.headers.get('Content-Length') || '',
      },
    });
  } catch {
    throw errors.badRequest('Could not download metrics database — node agent may be unreachable');
  }
});

/**
 * GET /:id/debug-package — Download a tar.gz archive with all diagnostic data
 * from the VM Agent: logs (cloud-init, journald, Docker), metrics DB, events DB,
 * system info, boot events, and system state snapshots.
 */
nodesRoutes.get('/:id/debug-package', async (c) => {
  const nodeId = c.req.param('id');
  const userId = getUserId(c);
  const node = await requireNodeOwnership(c, nodeId);

  if (!node) {
    throw errors.notFound('Node');
  }
  if (node.status !== 'running') {
    throw errors.badRequest('Node is not running');
  }

  try {
    const response = await nodeAgentRawRequest(nodeId, c.env, '/debug-package', userId);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`VM agent returned ${response.status}: ${body}`);
    }

    return new Response(response.body, {
      status: 200,
      headers: {
        'Content-Type': response.headers.get('Content-Type') || 'application/gzip',
        'Content-Disposition': response.headers.get('Content-Disposition') || `attachment; filename="debug-${nodeId}.tar.gz"`,
      },
    });
  } catch {
    throw errors.badRequest('Could not download debug package — node agent may be unreachable');
  }
});

export { nodesRoutes };
