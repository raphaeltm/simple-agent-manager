/**
 * Node lifecycle callback routes — ready, heartbeat, errors, and token issuance.
 *
 * These endpoints are called by the VM agent (ready, heartbeat, errors) or
 * the browser (token) and use callback JWT auth rather than user session auth.
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { jsonValidator, NodeErrorBatchSchema, NodeHeartbeatSchema } from '../schemas';
import { createNodeBackendDNSRecord, updateDNSRecord } from '../services/dns';
import {
  shouldRefreshCallbackToken,
  signCallbackToken,
  signNodeCallbackToken,
  signNodeManagementToken,
  verifyCallbackToken,
} from '../services/jwt';
import { createWorkspaceOnNode } from '../services/node-agent';
import { persistErrorBatch, type PersistErrorInput } from '../services/observability';
import * as projectDataService from '../services/project-data';

const nodeLifecycleRoutes = new Hono<{ Bindings: Env }>();

/**
 * POST /:id/token — Issue a node-scoped management token for direct VM Agent access.
 * The browser uses this token to call the VM Agent directly for node-level data
 * (events, health, etc.) without proxying through the control plane.
 */
nodeLifecycleRoutes.post('/:id/token', async (c) => {
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

nodeLifecycleRoutes.post('/:id/ready', async (c) => {
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

nodeLifecycleRoutes.post('/:id/heartbeat', jsonValidator(NodeHeartbeatSchema), async (c) => {
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

  // Backup ACP heartbeat sweep — primary heartbeat is now sent directly by the
  // VM agent via POST /api/projects/:id/node-acp-heartbeat. Retained as safety net.
  const acpSweepTimeoutMs = parseInt(c.env.HEARTBEAT_ACP_SWEEP_TIMEOUT_MS || '15000', 10);
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const workspaces = await db
          .select({ id: schema.workspaces.id, projectId: schema.workspaces.projectId })
          .from(schema.workspaces)
          .where(
            and(
              eq(schema.workspaces.nodeId, nodeId),
              eq(schema.workspaces.status, 'running'),
            )
          );

        const projectIds = [...new Set(workspaces.map((w) => w.projectId).filter(Boolean))] as string[];
        log.info('heartbeat.acp_sweep', { nodeId, workspaces: workspaces.length, projects: projectIds.length });

        await Promise.all(
          projectIds.map(async (projectId) => {
            try {
              const updated = await Promise.race([
                projectDataService.updateNodeHeartbeats(c.env, projectId, nodeId),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('acp_sweep_timeout')), acpSweepTimeoutMs)
                ),
              ]);
              log.info('heartbeat.acp_sweep_updated', { nodeId, projectId, updatedSessions: updated });
            } catch (err) {
              log.warn('heartbeat.acp_session_update_failed', { nodeId, projectId, error: String(err) });
            }
          })
        );
      } catch (err) {
        log.warn('heartbeat.acp_heartbeat_sweep_failed', { nodeId, error: String(err) });
      }
    })()
  );

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
nodeLifecycleRoutes.post('/:id/errors', jsonValidator(NodeErrorBatchSchema), async (c) => {
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

// --- Internal helpers ---

async function verifyNodeCallbackAuth(c: import('hono').Context<{ Bindings: Env }>, nodeId: string): Promise<void> {
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

export { nodeLifecycleRoutes };
