/**
 * Node lifecycle routes — VM-agent callbacks plus browser token issuance.
 *
 * These endpoints are called by the VM agent (ready, heartbeat, errors) or
 * the browser (token). VM-agent callbacks use callback JWT auth; the token
 * issuance route uses user session auth through the nodes route middleware.
 */
import { isUserOwnedNodeClass } from '@simple-agent-manager/shared';
import { and, eq, isNull, ne, notInArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { maybeJsonRecord } from '../lib/runtime-validation';
import { credentialNotAfter, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { jsonValidator, NodeHeartbeatSchema } from '../schemas';
import {
  shouldRefreshCallbackToken,
  signCurrentWorkspaceCallbackToken,
  signNodeCallbackToken,
  signNodeManagementToken,
} from '../services/jwt';
import { recordLifecycleTimings } from '../services/lifecycle-timings';
import { createWorkspaceOnNode } from '../services/node-agent';
import { isNodeAgentVersionCompatible } from '../services/node-agent-compatibility';
import { getNodeBackendBaseUrl } from '../services/node-agent-readiness';
import {
  NODE_CALLBACK_TERMINAL_STATUSES,
  nodeStatusBlocksTokenRefresh,
  nodeStatusTerminatesCallbacks,
  verifyNodeCallbackAuth,
} from '../services/node-callback-auth';
import { recordNodeHealthEvent } from '../services/node-health';
import { issueNodeOriginCertificate } from '../services/origin-ca-certificates';
import * as projectDataService from '../services/project-data';
import { wakeVmAdmissionWaiters } from '../services/vm-admission-control';
import { resolveWorkspaceGitSourceByProjectId } from '../services/workspace-git-source';
import { nodeDiagnosticIncidentRoutes } from './node-diagnostic-incidents';
import { applyDeploymentHeartbeat } from './node-heartbeat-deployment';
import { applyHeartbeatIp } from './node-heartbeat-ip';

const nodeLifecycleRoutes = new Hono<{ Bindings: Env }>();

function rejectTerminalNodeCallback(
  nodeId: string,
  status: string | null | undefined,
  callback: string
): never {
  const observedStatus = status ?? 'missing';
  log.info('node_callback.terminal_resource', {
    nodeId,
    status: observedStatus,
    callback,
    action: 'terminal_gone',
  });
  throw errors.gone(`Node is ${observedStatus}; callback resource is gone`);
}

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

  const { token, expiresAt } = await signNodeManagementToken(userId, nodeId, null, c.env, {
    notAfter: credentialNotAfter(c),
  });
  const nodeAgentUrl = getNodeBackendBaseUrl(nodeId, c.env);

  return c.json({ token, expiresAt, nodeAgentUrl });
});

nodeLifecycleRoutes.post('/:id/ready', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);
  const db = drizzle(c.env.DATABASE, { schema });
  const nodeRows = await db
    .select({ status: schema.nodes.status, runtime: schema.nodes.runtime })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .limit(1);
  const node = nodeRows[0];
  if (!node || nodeStatusTerminatesCallbacks(node.status)) {
    rejectTerminalNodeCallback(nodeId, node?.status, 'ready');
  }

  const now = new Date().toISOString();
  const contentType = c.req.header('content-type') || '';
  const readyPayload = contentType.includes('application/json')
    ? maybeJsonRecord(await c.req.json().catch(() => null))
    : null;
  const agentVersion =
    typeof readyPayload?.agentVersion === 'string' ? readyPayload.agentVersion : null;

  // The authenticated ready callback carries the compiled binary version.
  // Instant sessions remain available during gradual image rollouts.
  if (
    node.runtime === 'cf-container' &&
    !isNodeAgentVersionCompatible(agentVersion, c.env.VM_AGENT_REQUIRED_VERSION)
  ) {
    log.warn('instant_session.agent_version_mismatch', {
      nodeId,
      expectedVersion: c.env.VM_AGENT_REQUIRED_VERSION?.trim(),
      reportedVersion: agentVersion?.trim() || null,
    });
  }

  await recordLifecycleTimings(c.env.DATABASE, 'provision', readyPayload?.provisionTimings, {
    nodeId,
  });

  const updatedRows = await db
    .update(schema.nodes)
    .set({
      status: 'running',
      healthStatus: 'healthy',
      lastHeartbeatAt: now,
      agentReadyAt: now,
      agentVersion,
      updatedAt: now,
      cleanupBlockedSince: null,
      cleanupBlockedReason: null,
      cleanupBlockedAlertedAt: null,
    })
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        notInArray(schema.nodes.status, [...NODE_CALLBACK_TERMINAL_STATUSES])
      )
    )
    .returning({ status: schema.nodes.status });

  if (updatedRows.length === 0) {
    const latest = await db
      .select({ status: schema.nodes.status })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    rejectTerminalNodeCallback(nodeId, latest?.status, 'ready');
  }

  c.executionCtx.waitUntil(
    (async () => {
      const innerDb = drizzle(c.env.DATABASE, { schema });
      const pendingWorkspaces = await innerDb
        .select({
          id: schema.workspaces.id,
          userId: schema.workspaces.userId,
          repository: schema.workspaces.repository,
          branch: schema.workspaces.branch,
          projectId: schema.workspaces.projectId,
        })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.nodeId, nodeId),
            eq(schema.workspaces.status, 'creating'),
            isNull(schema.workspaces.dispatchedAt),
            // cf-container (standalone) workspaces are provisioned by their own
            // launch flow with a lightweight profile. Re-dispatching them here
            // via createWorkspaceOnNode omits `lightweight`, so the VM agent
            // rejects it with a 409 profile conflict and the workspace is
            // wrongly marked `error`. Never re-dispatch cf-container workspaces.
            ne(schema.workspaces.vmLocation, 'cf-container')
          )
        );

      for (const workspace of pendingWorkspaces) {
        try {
          // Intentionally workspace-scoped (not signNodeCallbackToken) — this token
          // is for a specific workspace's VM agent callbacks, not node-level operations.
          const callbackToken = await signCurrentWorkspaceCallbackToken(workspace.id, c.env);
          const gitSource = await resolveWorkspaceGitSourceByProjectId(
            innerDb,
            workspace.projectId
          );
          await createWorkspaceOnNode(nodeId, c.env, workspace.userId, {
            workspaceId: workspace.id,
            repository: workspace.repository,
            branch: workspace.branch,
            ...gitSource,
            callbackToken,
          });
          await innerDb
            .update(schema.workspaces)
            .set({ dispatchedAt: new Date().toISOString() })
            .where(eq(schema.workspaces.id, workspace.id));
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

      try {
        const readyNode = await innerDb
          .select({ userId: schema.nodes.userId })
          .from(schema.nodes)
          .where(eq(schema.nodes.id, nodeId))
          .limit(1);
        const ownerUserId = readyNode[0]?.userId ?? null;
        if (ownerUserId) {
          await wakeVmAdmissionWaiters(c.env, {
            userId: ownerUserId,
            reason: 'node_ready',
          });
        }
      } catch (err) {
        log.warn('node_ready.vm_admission_wakeup_failed', {
          nodeId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })()
  );

  return c.json({ status: 'running', readyAt: now });
});

/**
 * POST /:id/origin-ca-certificate — Sign a node-generated CSR with Cloudflare Origin CA.
 *
 * Cloud-init generates the private key locally and sends only the CSR here.
 * The returned certificate is paired with that node-local private key, so the
 * platform-wide Origin CA private key is never embedded in static user-data.
 */
nodeLifecycleRoutes.post('/:id/origin-ca-certificate', async (c) => {
  const nodeId = c.req.param('id');
  await verifyNodeCallbackAuth(c, nodeId);

  // Server-side ownership gate: NEVER hand a platform-wide `*.{BASE_DOMAIN}` wildcard Origin CA
  // cert to a user-owned (BYO) machine — a BYO owner holds a valid callback token for their own
  // node and could otherwise `curl` this endpoint to extract the platform wildcard cert+key.
  // Tunnel-transport nodes never need Origin CA at all (cloudflared terminates TLS at the edge).
  // This gate is independent of what the agent chooses to send. See security-critique #2, rule 28.
  const gateDb = drizzle(c.env.DATABASE, { schema });
  const nodeRow = await gateDb
    .select({
      nodeClass: schema.nodes.nodeClass,
      status: schema.nodes.status,
      transport: schema.nodes.transport,
    })
    .from(schema.nodes)
    .where(eq(schema.nodes.id, nodeId))
    .get();
  if (!nodeRow || nodeStatusTerminatesCallbacks(nodeRow.status)) {
    rejectTerminalNodeCallback(nodeId, nodeRow?.status, 'origin_ca_certificate');
  }
  if (isUserOwnedNodeClass(nodeRow.nodeClass) || nodeRow.transport === 'cloudflare-tunnel') {
    log.error('node_origin_ca_certificate.denied_user_owned', {
      nodeId,
      nodeClass: nodeRow.nodeClass,
      transport: nodeRow.transport,
      action: 'rejected',
    });
    throw errors.forbidden('Origin CA issuance is not available for user-owned nodes');
  }

  const csr = await c.req.text();
  try {
    const result = await issueNodeOriginCertificate(c.env, csr);
    log.info('node_origin_ca_certificate.issued', {
      nodeId,
      certificateId: result.certificateId,
      expiresOn: result.expiresOn,
      hostnames: result.hostnames,
      requestedValidity: result.requestedValidity,
    });
    return c.text(result.certificate, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Origin CA certificate issuance failed';
    log.error('node_origin_ca_certificate.failed', { nodeId, error: message });
    if (message.includes('CSR')) {
      throw errors.badRequest('Invalid Origin CA CSR');
    }
    throw errors.internal('Origin CA certificate issuance failed');
  }
});

nodeLifecycleRoutes.post('/:id/heartbeat', jsonValidator(NodeHeartbeatSchema), async (c) => {
  const nodeId = c.req.param('id');
  const auth = await verifyNodeCallbackAuth(c, nodeId);

  // Extract raw token for refresh check (auth already verified above)
  const rawToken = extractBearerToken(c.req.header('Authorization'));
  const tokenNeedsRefresh = shouldRefreshCallbackToken(rawToken, c.env);

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  const body = c.req.valid('json');

  // Read the node first to check if IP backfill is needed
  const rows = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);

  const node = rows[0];
  if (!node || nodeStatusTerminatesCallbacks(node.status)) {
    rejectTerminalNodeCallback(nodeId, node?.status, 'heartbeat');
  }

  const updatePayload: Record<string, unknown> = {
    lastHeartbeatAt: now,
    healthStatus: 'healthy',
    updatedAt: now,
  };

  if (body.agentVersion) {
    updatePayload.agentVersion = body.agentVersion;
  }

  if (body.metrics || body.deployment || typeof body.creatingWorkspaces === 'number') {
    updatePayload.lastMetrics = JSON.stringify({
      ...(body.metrics ?? {}),
      ...(typeof body.creatingWorkspaces === 'number'
        ? { creatingWorkspaces: body.creatingWorkspaces }
        : {}),
      ...(body.deployment ? { deployment: body.deployment } : {}),
    });
  }

  await applyHeartbeatIp({ c, node, nodeId, updatePayload });

  if (updatePayload.status) {
    updatePayload.cleanupBlockedSince = null;
    updatePayload.cleanupBlockedReason = null;
    updatePayload.cleanupBlockedAlertedAt = null;
  }

  const updatedRows = await db
    .update(schema.nodes)
    .set(updatePayload)
    .where(
      and(
        eq(schema.nodes.id, nodeId),
        notInArray(schema.nodes.status, [...NODE_CALLBACK_TERMINAL_STATUSES])
      )
    )
    .returning({ status: schema.nodes.status });

  if (updatedRows.length === 0) {
    const latest = await db
      .select({ status: schema.nodes.status })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, nodeId))
      .get();
    rejectTerminalNodeCallback(nodeId, latest?.status, 'heartbeat');
  }

  if (node.healthStatus === 'unhealthy' && node.lastHeartbeatAt) {
    await recordNodeHealthEvent(c.env, {
      nodeId,
      episodeStartedAt: node.lastHeartbeatAt,
      event: 'recovered',
      reason: 'node_heartbeat_resumed',
      createdAt: now,
    });
  }

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
            and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.status, 'running'))
          );

        const projectIds = [
          ...new Set(workspaces.map((w) => w.projectId).filter(Boolean)),
        ] as string[];
        log.debug('heartbeat.acp_sweep', {
          nodeId,
          workspaces: workspaces.length,
          projects: projectIds.length,
        });

        await Promise.all(
          projectIds.map(async (projectId) => {
            try {
              const updated = await Promise.race([
                projectDataService.updateNodeHeartbeats(c.env, projectId, nodeId),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error('acp_sweep_timeout')), acpSweepTimeoutMs)
                ),
              ]);
              log.debug('heartbeat.acp_sweep_updated', {
                nodeId,
                projectId,
                updatedSessions: updated,
              });
            } catch (err) {
              log.warn('heartbeat.acp_session_update_failed', {
                nodeId,
                projectId,
                error: String(err),
              });
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
    // Revocation-on-refresh: a callback JWT self-renews forever via heartbeat, so a deregistered/
    // deleted node would keep a live, auto-renewing credential. Stop honoring the refresh once the
    // node reaches a terminal status so deregistration actually ends the cycle. See security-critique #4.
    if (nodeStatusBlocksTokenRefresh(node.status)) {
      log.warn('heartbeat.token_refresh_skipped_terminal_node', {
        nodeId,
        status: node.status,
        action: 'refresh_skipped',
      });
    } else {
      // Carry the generation this request proved, never a fresher one read now: a retired
      // runtime that heartbeats after a rotation must not be handed the new runtime's token.
      response.refreshedToken = await signNodeCallbackToken(nodeId, c.env, {
        callbackGeneration: auth.callbackGeneration,
      });
    }
  }

  // Deployment mode: include pending release seqs and deploy pub key for deployment nodes.
  // SECURITY: Look up environments from the authenticated node's placement records —
  // never trust environment IDs from the request body for authorization (IDOR risk).
  if (node.nodeRole === 'deployment' && body.deployment) {
    await applyDeploymentHeartbeat({
      c,
      db,
      node,
      nodeId,
      deployment: body.deployment,
      now,
      response,
    });
  }

  return c.json(response);
});

nodeLifecycleRoutes.route('/', nodeDiagnosticIncidentRoutes);

export { nodeLifecycleRoutes };
