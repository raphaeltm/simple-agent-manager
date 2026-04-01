import type { NodeHealthStatus, NodeResponse } from '@simple-agent-manager/shared';
import { DEFAULT_VM_LOCATION, DEFAULT_VM_SIZE, getLocationsForProvider,isValidLocationForProvider } from '@simple-agent-manager/shared';
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Context } from 'hono';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../index';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { getUserId, requireApproved,requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { CreateNodeSchema, jsonValidator, NodeErrorBatchSchema,NodeHeartbeatSchema } from '../schemas';
import { createNodeBackendDNSRecord, updateDNSRecord } from '../services/dns';
import { shouldRefreshCallbackToken, signCallbackToken, signNodeCallbackToken, signNodeManagementToken, verifyCallbackToken } from '../services/jwt';
import { getRuntimeLimits } from '../services/limits';
import {
  createWorkspaceOnNode,
  getNodeLogsFromNode,
  getNodeSystemInfoFromNode,
  listNodeEventsOnNode,
  stopWorkspaceOnNode,
} from '../services/node-agent';
import { createNodeRecord, deleteNodeResources, provisionNode, stopNodeResources } from '../services/nodes';
import { persistErrorBatch, type PersistErrorInput } from '../services/observability';
import { recordNodeRoutingMetric } from '../services/telemetry';

const nodesRoutes = new Hono<{ Bindings: Env }>();

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

async function verifyNodeCallbackAuth(c: Context<{ Bindings: Env }>, nodeId: string): Promise<void> {
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);

  // Workspace-scoped tokens CANNOT be used for node-level endpoints.
  if (payload.scope === 'workspace') {
    log.error('node_auth.rejected_workspace_scoped_token', {
      tokenWorkspace: payload.workspace,
      nodeId,
      scope: payload.scope,
      action: 'rejected',
    });
    throw errors.forbidden('Insufficient token scope');
  }

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
  const nodeAgentUrl = `https://${nodeId.toLowerCase()}.vm.${c.env.BASE_DOMAIN}:${c.env.VM_AGENT_PORT || '8443'}`;

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
          // Intentionally workspace-scoped (not signNodeCallbackToken) — this token
          // is for a specific workspace's VM agent callbacks, not node-level operations.
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

nodesRoutes.post('/:id/heartbeat', jsonValidator(NodeHeartbeatSchema), async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);

  // Extract raw token for refresh check (auth already verified above)
  const rawToken = extractBearerToken(c.req.header('Authorization'));
  const tokenNeedsRefresh = shouldRefreshCallbackToken(rawToken, c.env);

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  const body = c.req.valid('json');

  // Read the node first to check if IP backfill is needed
  const rows = await db
    .select()
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);

  const node = rows[0];
  if (!node) {
    throw errors.notFound('Node');
  }

  const updatePayload: Record<string, unknown> = {
    lastHeartbeatAt: now,
    healthStatus: 'healthy',
    updatedAt: now,
  };

  if (body.metrics) {
    updatePayload.lastMetrics = JSON.stringify(body.metrics);
  }

  // Self-heal stale "Awaiting IP allocation" error on nodes that already have an IP.
  // This handles nodes where the IP was backfilled before this fix was deployed.
  if (node.ipAddress && node.errorMessage?.includes('Awaiting IP allocation')) {
    updatePayload.errorMessage = sql`NULL`;
  }

  // Defense-in-depth: backfill IP from heartbeat if node has no IP stored.
  // This self-heals Scaleway nodes where the IP wasn't captured at creation time.
  if (!node.ipAddress) {
    const heartbeatIp = c.req.header('CF-Connecting-IP');
    if (heartbeatIp) {
      log.info('heartbeat.ip_backfilled', {
        nodeId,
        backfilledIp: heartbeatIp,
        action: 'ip_backfilled',
      });
      updatePayload.ipAddress = heartbeatIp;

      // Always clear the "Awaiting IP allocation" error when IP is backfilled.
      // Use explicit SQL null to ensure Drizzle/D1 generates SET errorMessage = NULL
      // (assigning null to a Record<string, unknown> property may be silently dropped).
      updatePayload.errorMessage = sql`NULL`;

      // Transition to running if the node was awaiting IP allocation
      if (node.status === 'creating' || node.status === 'error') {
        updatePayload.status = 'running';
      }

      // Update DNS record if we have one, or create a new one
      try {
        if (node.backendDnsRecordId) {
          await updateDNSRecord(node.backendDnsRecordId, heartbeatIp, c.env);
        } else {
          const dnsRecordId = await createNodeBackendDNSRecord(nodeId, heartbeatIp, c.env);
          updatePayload.backendDnsRecordId = dnsRecordId;
        }
      } catch (dnsErr) {
        log.error('heartbeat.dns_update_failed_during_ip_backfill', { nodeId, error: String(dnsErr) });
      }
    }
  }

  await db
    .update(schema.nodes)
    .set(updatePayload)
    .where(eq(schema.nodes.id, nodeId));

  const response: Record<string, unknown> = {
    status: node.status,
    lastHeartbeatAt: now,
    healthStatus: 'healthy',
  };

  if (tokenNeedsRefresh) {
    response.refreshedToken = await signNodeCallbackToken(nodeId, c.env);
  }

  return c.json(response);
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
 * Workers observability via structured logger. Uses callback JWT auth
 * (same as heartbeat/ready). Returns 204.
 *
 * Body: { errors: VMAgentErrorEntry[] }
 */
nodesRoutes.post('/:id/errors', jsonValidator(NodeErrorBatchSchema), async (c) => {
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

  const body = c.req.valid('json');
  const entries = body.errors;

  if (entries.length === 0) {
    return c.body(null, 204);
  }

  if (entries.length > maxBatchSize) {
    throw errors.badRequest(`Batch too large (max ${maxBatchSize} entries)`);
  }

  // Collect validated entries for D1 persistence
  const persistInputs: PersistErrorInput[] = [];

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

    log.error('vm_agent_error', {
      level,
      message: truncateString(message, MAX_VM_ERROR_MESSAGE_LENGTH),
      source: truncateString(source, MAX_VM_ERROR_SOURCE_LENGTH),
      stack: typeof e.stack === 'string' ? truncateString(e.stack, MAX_VM_ERROR_STACK_LENGTH) : null,
      workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
      context: e.context && typeof e.context === 'object' ? e.context : null,
      nodeId,
    });

    // Collect for D1 persistence
    persistInputs.push({
      source: 'vm-agent',
      level: level as PersistErrorInput['level'],
      message,
      stack: typeof e.stack === 'string' ? e.stack : null,
      context: e.context && typeof e.context === 'object' ? e.context as Record<string, unknown> : null,
      nodeId,
      workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null,
      timestamp: typeof e.timestamp === 'string' ? new Date(e.timestamp).getTime() || Date.now() : Date.now(),
    });
  }

  // Persist to observability D1 (fire-and-forget, fail-silent)
  if (persistInputs.length > 0 && c.env.OBSERVABILITY_DATABASE) {
    const promise = persistErrorBatch(c.env.OBSERVABILITY_DATABASE, persistInputs, c.env)
      .catch((e) => { log.error('observability.persist_error_batch_failed', { count: persistInputs.length, error: String(e) }); });
    try { c.executionCtx.waitUntil(promise); } catch { /* no exec ctx (e.g. tests) */ }
  }

  return c.body(null, 204);
});

export { nodesRoutes };
