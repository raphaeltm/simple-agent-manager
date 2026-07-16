/**
 * Node lifecycle callback routes — ready, heartbeat, errors, and token issuance.
 *
 * These endpoints are called by the VM agent (ready, heartbeat, errors) or
 * the browser (token) and use callback JWT auth rather than user session auth.
 */
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { extractBearerToken } from '../lib/auth-helpers';
import { log } from '../lib/logger';
import { expectJsonRecord, maybeJsonRecord } from '../lib/runtime-validation';
import { getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { jsonValidator, NodeErrorBatchSchema, NodeHeartbeatSchema } from '../schemas';
import {
  buildObservedDeploymentUpdate,
  reconcileDeploymentReleaseStatuses,
} from '../services/deployment-control';
import { reconcileCustomDomainRoutingObservation } from '../services/deployment-custom-domains';
import { createNodeBackendDNSRecord, updateDNSRecord } from '../services/dns';
import {
  shouldRefreshCallbackToken,
  signCallbackToken,
  signNodeCallbackToken,
  signNodeManagementToken,
} from '../services/jwt';
import { createWorkspaceOnNode } from '../services/node-agent';
import { verifyNodeCallbackAuth } from '../services/node-callback-auth';
import { persistErrorBatch, type PersistErrorInput } from '../services/observability';
import { issueNodeOriginCertificate } from '../services/origin-ca-certificates';
import * as projectDataService from '../services/project-data';
import { resolveWorkspaceGitSourceByProjectId } from '../services/workspace-git-source';

const nodeLifecycleRoutes = new Hono<{ Bindings: Env }>();
const NODE_DNS_ERROR_MESSAGE_MAX_LENGTH = 500;
const NODE_BACKEND_DNS_ERROR_PREFIX = 'Backend DNS record creation failed:';

function truncateNodeLifecycleError(value: string): string {
  return value.length > NODE_DNS_ERROR_MESSAGE_MAX_LENGTH
    ? `${value.slice(0, NODE_DNS_ERROR_MESSAGE_MAX_LENGTH - 3)}...`
    : value;
}

function isBackendDnsError(errorMessage: string | null | undefined): boolean {
  return !!errorMessage && errorMessage.startsWith(NODE_BACKEND_DNS_ERROR_PREFIX);
}

function isValidIPv4Address(value: string | null | undefined): value is string {
  if (!value) return false;

  const octets = value.split('.');
  if (octets.length !== 4) return false;

  return octets.every((octet) => {
    if (!/^\d+$/.test(octet)) return false;
    const numeric = Number(octet);
    return numeric >= 0 && numeric <= 255;
  });
}

async function deploymentVolumesReadyForNode(params: {
  database: Env['DATABASE'];
  environmentId: string;
  eventName: string;
  nodeId: string;
  providerInstanceId: string | null | undefined;
  requiresVolumes: boolean;
}): Promise<boolean> {
  if (!params.requiresVolumes) {
    return true;
  }

  const volumeReadiness = await params.database
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COUNT(CASE WHEN attached_server_id = ? THEN 1 END) AS attached
       FROM deployment_volumes
       WHERE environment_id = ?`
    )
    .bind(params.providerInstanceId ?? '', params.environmentId)
    .first<{ total: number; attached: number }>();

  if (
    !volumeReadiness ||
    volumeReadiness.total === 0 ||
    volumeReadiness.attached < volumeReadiness.total
  ) {
    log.info(params.eventName, {
      nodeId: params.nodeId,
      environmentId: params.environmentId,
      total: volumeReadiness?.total ?? 0,
      attached: volumeReadiness?.attached ?? 0,
    });
    return false;
  }

  return true;
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
      agentReadyAt: now,
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
          const callbackToken = await signCallbackToken(workspace.id, c.env);
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
  await verifyNodeCallbackAuth(c, nodeId);

  // Extract raw token for refresh check (auth already verified above)
  const rawToken = extractBearerToken(c.req.header('Authorization'));
  const tokenNeedsRefresh = shouldRefreshCallbackToken(rawToken, c.env);

  const db = drizzle(c.env.DATABASE, { schema });
  const now = new Date().toISOString();

  const body = c.req.valid('json');

  // Read the node first to check if IP backfill is needed
  const rows = await db.select().from(schema.nodes).where(eq(schema.nodes.id, nodeId)).limit(1);

  const node = rows[0];
  if (!node) {
    throw errors.notFound('Node');
  }

  const updatePayload: Record<string, unknown> = {
    lastHeartbeatAt: now,
    healthStatus: 'healthy',
    updatedAt: now,
  };

  if (body.metrics || body.deployment) {
    updatePayload.lastMetrics = JSON.stringify({
      ...(body.metrics ?? {}),
      ...(body.deployment ? { deployment: body.deployment } : {}),
    });
  }

  // Self-heal stale "Awaiting IP allocation" error on nodes that already have an IP.
  // This handles nodes where the IP was backfilled before this fix was deployed.
  if (node.ipAddress && node.errorMessage?.includes('Awaiting IP allocation')) {
    updatePayload.errorMessage = sql`NULL`;
  }

  const heartbeatIp = c.req.header('CF-Connecting-IP');

  // Defense-in-depth: backfill IP from heartbeat if node has no IP stored.
  // This self-heals Scaleway nodes where the IP wasn't captured at creation time.
  let effectiveNodeIp = node.ipAddress;

  if (!node.ipAddress) {
    if (heartbeatIp) {
      log.info('heartbeat.ip_backfilled', {
        nodeId,
        backfilledIp: heartbeatIp,
        action: 'ip_backfilled',
      });
      updatePayload.ipAddress = heartbeatIp;
      effectiveNodeIp = heartbeatIp;

      // Always clear the "Awaiting IP allocation" error when IP is backfilled.
      // Use explicit SQL null to ensure Drizzle/D1 generates SET errorMessage = NULL
      // (assigning null to a Record<string, unknown> property may be silently dropped).
      updatePayload.errorMessage = sql`NULL`;

      // Transition to running if the node was awaiting IP allocation
      if (node.status === 'creating' || node.status === 'error') {
        updatePayload.status = 'running';
      }
    }
  }

  if (effectiveNodeIp) {
    const heartbeatIpv4 = isValidIPv4Address(heartbeatIp) ? heartbeatIp : null;
    const dnsIp = heartbeatIpv4 || effectiveNodeIp;
    try {
      if (node.backendDnsRecordId) {
        if (heartbeatIpv4 && heartbeatIpv4 !== node.ipAddress) {
          await updateDNSRecord(node.backendDnsRecordId, heartbeatIpv4, c.env);
          log.info('heartbeat.backend_dns_updated', {
            nodeId,
            ipAddress: heartbeatIpv4,
            previousIpAddress: node.ipAddress,
          });
        }
      } else {
        const dnsRecordId = await createNodeBackendDNSRecord(nodeId, dnsIp, c.env);
        updatePayload.backendDnsRecordId = dnsRecordId;
        if (isBackendDnsError(node.errorMessage)) {
          updatePayload.errorMessage = sql`NULL`;
          if (node.status === 'error') {
            updatePayload.status = 'running';
          }
        }
        log.info('heartbeat.backend_dns_backfilled', {
          nodeId,
          ipAddress: dnsIp,
          source: heartbeatIpv4 ? 'heartbeat' : 'stored',
        });
      }
    } catch (dnsErr) {
      const message = dnsErr instanceof Error ? dnsErr.message : String(dnsErr);
      updatePayload.errorMessage = truncateNodeLifecycleError(
        `${NODE_BACKEND_DNS_ERROR_PREFIX} ${message}`
      );
      log.error('heartbeat.backend_dns_backfill_failed', {
        nodeId,
        ipAddress: dnsIp,
        hasExistingDnsRecord: !!node.backendDnsRecordId,
        error: String(dnsErr),
      });
    }
  }

  await db.update(schema.nodes).set(updatePayload).where(eq(schema.nodes.id, nodeId));

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
    response.refreshedToken = await signNodeCallbackToken(nodeId, c.env);
  }

  // Deployment mode: include pending release seqs and deploy pub key for deployment nodes.
  // SECURITY: Look up environments from the authenticated node's placement records —
  // never trust environment IDs from the request body for authorization (IDOR risk).
  if (node.nodeRole === 'deployment' && body.deployment) {
    try {
      const envRows = await db
        .select({
          envId: schema.deploymentEnvironments.id,
          status: schema.deploymentEnvironments.status,
          requiresVolumes: schema.deploymentEnvironments.requiresVolumes,
          observedAppliedSeq: schema.deploymentEnvironments.observedAppliedSeq,
          desiredRoutingRevision: schema.deploymentEnvironments.desiredRoutingRevision,
          observedRoutingRevision: schema.deploymentEnvironments.observedRoutingRevision,
        })
        .from(schema.deploymentEnvironments)
        .where(eq(schema.deploymentEnvironments.nodeId, nodeId));
      const activeEnvRows = envRows.filter(
        (row) => row.status === 'active' || row.status === 'starting'
      );
      const placedEnvIds = new Set(activeEnvRows.map((row) => row.envId));
      const bodyStates = Array.isArray(body.deployment.environments)
        ? body.deployment.environments
        : [];
      const reportedEnvIds = Array.from(
        new Set(
          bodyStates
            .map((state) => state.environmentId.trim())
            .filter((environmentId) => environmentId.length > 0)
        )
      );
      const retireEnvironments = reportedEnvIds
        .filter((environmentId) => !placedEnvIds.has(environmentId))
        .map((environmentId) => ({ environmentId }));

      response.deployment = {
        environments: activeEnvRows.map((row) => ({ environmentId: row.envId })),
        ...(retireEnvironments.length > 0 ? { retireEnvironments } : {}),
      };

      const stateByEnv = new Map(bodyStates.map((state) => [state.environmentId, state]));

      const pendingReleases: Array<{ environmentId: string; seq: number }> = [];
      const pendingRouteConfigs: Array<{ environmentId: string; revision: number }> = [];

      for (const envRow of activeEnvRows) {
        const envId = envRow.envId;
        const bodyState = stateByEnv.get(envId);
        const deploymentState = bodyState ?? null;
        const appliedSeq = deploymentState?.appliedSeq ?? envRow.observedAppliedSeq ?? 0;

        if (deploymentState) {
          const observedUpdate = buildObservedDeploymentUpdate(deploymentState, now);
          if (envRow.status === 'starting' && deploymentState.status === 'applied') {
            observedUpdate.status = 'active';
          } else if (
            envRow.status === 'starting' &&
            (deploymentState.status === 'failed' || deploymentState.status === 'failed-initial')
          ) {
            observedUpdate.status = 'error';
          }

          await db
            .update(schema.deploymentEnvironments)
            .set(observedUpdate)
            .where(
              and(
                eq(schema.deploymentEnvironments.id, envId),
                eq(schema.deploymentEnvironments.nodeId, nodeId)
              )
            );

          await reconcileDeploymentReleaseStatuses(db, envId, deploymentState);
          if (typeof deploymentState.routingRevision === 'number') {
            await reconcileCustomDomainRoutingObservation(
              db,
              envId,
              Math.floor(deploymentState.routingRevision),
              deploymentState.routingStatus,
              now
            );
          }
        }

        const latestRelease = await db
          .select({
            version: schema.deploymentReleases.version,
            status: schema.deploymentReleases.status,
          })
          .from(schema.deploymentReleases)
          .where(eq(schema.deploymentReleases.environmentId, envId))
          .orderBy(desc(schema.deploymentReleases.version))
          .limit(1);

        const latest = latestRelease[0];
        const nodeAlreadyApplying = deploymentState?.status === 'applying';
        if (
          latest &&
          latest.version > appliedSeq &&
          (latest.status === 'created' || (latest.status === 'applying' && !nodeAlreadyApplying))
        ) {
          if (
            !(await deploymentVolumesReadyForNode({
              database: c.env.DATABASE,
              environmentId: envId,
              eventName: 'heartbeat.deploy_release_waiting_for_volume_attach',
              nodeId,
              providerInstanceId: node.providerInstanceId,
              requiresVolumes: envRow.requiresVolumes,
            }))
          ) {
            continue;
          }
          pendingReleases.push({ environmentId: envId, seq: latest.version });
        }

        const reportedRoutingRevision =
          typeof deploymentState?.routingRevision === 'number'
            ? Math.floor(deploymentState.routingRevision)
            : (envRow.observedRoutingRevision ?? 0);
        const desiredRoutingRevision = envRow.desiredRoutingRevision ?? 0;
        const hasCurrentAppliedRelease = !!latest && appliedSeq > 0 && latest.version <= appliedSeq;
        if (
          desiredRoutingRevision > reportedRoutingRevision &&
          hasCurrentAppliedRelease &&
          !nodeAlreadyApplying
        ) {
          if (
            !(await deploymentVolumesReadyForNode({
              database: c.env.DATABASE,
              environmentId: envId,
              eventName: 'heartbeat.deploy_routes_waiting_for_volume_attach',
              nodeId,
              providerInstanceId: node.providerInstanceId,
              requiresVolumes: envRow.requiresVolumes,
            }))
          ) {
            continue;
          }
          pendingRouteConfigs.push({ environmentId: envId, revision: desiredRoutingRevision });
        }
      }

      if (pendingReleases.length > 0) {
        response.deployment = {
          ...(response.deployment as Record<string, unknown>),
          pendingReleases,
        };
        if (pendingReleases.length === 1) {
          response.pendingReleaseSeq = pendingReleases[0]?.seq;
        }
      }
      if (pendingRouteConfigs.length > 0) {
        response.deployment = {
          ...(response.deployment as Record<string, unknown>),
          pendingRouteConfigs,
        };
      }
    } catch (err) {
      log.warn('heartbeat.deploy_release_lookup_failed', {
        nodeId,
        error: String(err),
      });
    }

    // Include deploy signing public key for key refresh
    if (c.env.DEPLOY_SIGNING_PUBLIC_KEY) {
      response.deployPubKey = c.env.DEPLOY_SIGNING_PUBLIC_KEY;
      response.deployment = {
        ...(typeof response.deployment === 'object' && response.deployment !== null
          ? (response.deployment as Record<string, unknown>)
          : {}),
        deployPubKey: c.env.DEPLOY_SIGNING_PUBLIC_KEY,
      };
    }
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

type VMAgentReportLevel = 'error' | 'warn' | 'info';

const VALID_VM_ERROR_LEVELS = new Set<string>(['error', 'warn', 'info']);

function isVMAgentReportLevel(value: unknown): value is VMAgentReportLevel {
  return typeof value === 'string' && VALID_VM_ERROR_LEVELS.has(value);
}

function normalizeVMAgentReportLevel(value: unknown): VMAgentReportLevel {
  return isVMAgentReportLevel(value) ? value : 'error';
}

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
    let e: Record<string, unknown>;
    try {
      e = expectJsonRecord(entry, 'node-lifecycle.error.entry');
    } catch {
      continue;
    }

    // Validate required fields
    const message = typeof e.message === 'string' ? e.message : null;
    const source = typeof e.source === 'string' ? e.source : null;

    if (!message || !source) continue; // Skip malformed entries

    // VM agent reports include both failures and operational lifecycle entries.
    // Preserve the agent's intentional severity: info for successful progress,
    // warn for degraded/non-fatal behavior, error for user-impacting failures.
    const level = normalizeVMAgentReportLevel(e.level);

    log[level]('vm_agent_error', {
      level,
      message: truncateString(message, MAX_VM_ERROR_MESSAGE_LENGTH),
      source: truncateString(source, MAX_VM_ERROR_SOURCE_LENGTH),
      stack:
        typeof e.stack === 'string' ? truncateString(e.stack, MAX_VM_ERROR_STACK_LENGTH) : null,
      workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null,
      timestamp: typeof e.timestamp === 'string' ? e.timestamp : null,
      context: maybeJsonRecord(e.context),
      nodeId,
    });

    // Collect for D1 persistence
    persistInputs.push({
      source: 'vm-agent',
      level: level as PersistErrorInput['level'],
      message,
      stack: typeof e.stack === 'string' ? e.stack : null,
      context: maybeJsonRecord(e.context),
      nodeId,
      workspaceId: typeof e.workspaceId === 'string' ? e.workspaceId : null,
      timestamp:
        typeof e.timestamp === 'string'
          ? new Date(e.timestamp).getTime() || Date.now()
          : Date.now(),
    });
  }

  // Persist to observability D1 (fire-and-forget, fail-silent)
  if (persistInputs.length > 0 && c.env.OBSERVABILITY_DATABASE) {
    const promise = persistErrorBatch(c.env.OBSERVABILITY_DATABASE, persistInputs, c.env).catch(
      (e) => {
        log.error('observability.persist_error_batch_failed', {
          count: persistInputs.length,
          error: String(e),
        });
      }
    );
    try {
      c.executionCtx.waitUntil(promise);
    } catch {
      /* no exec ctx (e.g. tests) */
    }
  }

  return c.body(null, 204);
});

export { nodeLifecycleRoutes };
