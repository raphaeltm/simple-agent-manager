import {
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  getLocationsForProvider,
  isValidLocationForProvider,
} from '@simple-agent-manager/shared';
import { and, desc, eq, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireNodeOwnership } from '../middleware/node-auth';
import { CreateNodeSchema, jsonValidator } from '../schemas';
import { resolveCanonicalVmAllocationPlan } from '../services/canonical-vm-allocation';
import { scheduleDirectProvisioning } from '../services/direct-provisioning';
import { getRuntimeLimits } from '../services/limits';
import { stopWorkspaceOnNode } from '../services/node-agent';
import { createNodeRecord, stopNodeResources } from '../services/nodes';
import { recordNodeRoutingMetric } from '../services/telemetry';
import { deleteNodeRoute } from './nodes/delete';
import { nodeDiagnosticsRoutes } from './nodes/diagnostics';
import {
  loadDeploymentEnvironmentSummaries,
  refreshNodeHealth,
  toNodeResponse,
} from './nodes/response';

const nodesRoutes = new Hono<{ Bindings: Env }>();

// All node CRUD/observability routes require user auth.
// Lifecycle callbacks (ready, heartbeat, errors) are on nodeLifecycleRoutes
// and use callback JWT auth instead — but since both routers are mounted at
// /api/nodes, Hono's wildcard middleware here can match lifecycle paths too.
// We keep the skip to prevent auth middleware from blocking those requests.
nodesRoutes.use('/*', async (c, next) => {
  const path = c.req.path;
  if (
    path.endsWith('/ready') ||
    path.endsWith('/heartbeat') ||
    path.endsWith('/errors') ||
    path.includes('/diagnostic-incidents/') ||
    path.endsWith('/deploy-release') ||
    path.endsWith('/deploy-routes') ||
    path.endsWith('/origin-ca-certificate')
  ) {
    return next();
  }
  return requireAuth()(c, async () => {
    await requireApproved()(c, next);
  });
});

function optionalPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw errors.badRequest(`${field} must be a positive integer`);
  }
  return value;
}

function optionalTrimmedString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

nodesRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });

  const nodes = await db
    .select()
    .from(schema.nodes)
    .where(and(eq(schema.nodes.userId, userId), ne(schema.nodes.status, 'deleted')))
    .orderBy(desc(schema.nodes.createdAt));

  const hydrated = await Promise.all(nodes.map((node) => refreshNodeHealth(db, node, c.env)));
  const deploymentSummaries = await loadDeploymentEnvironmentSummaries(
    db,
    hydrated
      .filter((node) => (node.nodeRole ?? 'workspace') === 'deployment')
      .map((node) => node.id)
  );
  return c.json(
    hydrated.map((node) => toNodeResponse(node, deploymentSummaries.get(node.id) ?? []))
  );
});

nodesRoutes.post('/', jsonValidator(CreateNodeSchema), async (c) => {
  const userId = getUserId(c);
  const db = drizzle(c.env.DATABASE, { schema });
  const body = c.req.valid('json');
  const limits = getRuntimeLimits(c.env);

  if (!body.name?.trim()) {
    throw errors.badRequest('Node name is required');
  }

  // Only count workspace-role nodes against the user's node quota.
  // Deployment-role nodes are managed separately and exempt from this limit.
  // User-owned (BYO) nodes cost SAM nothing to run, so they never consume a MAX_NODES_PER_USER
  // slot — otherwise a few enrolled machines could block cloud auto-provisioning (critique #8).
  const existingNodes = await db
    .select({ id: schema.nodes.id })
    .from(schema.nodes)
    .where(
      and(
        eq(schema.nodes.userId, userId),
        ne(schema.nodes.status, 'deleted'),
        eq(schema.nodes.nodeRole, 'workspace'),
        ne(schema.nodes.nodeClass, 'user-owned')
      )
    );

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

  const providerInstanceType =
    optionalTrimmedString(body.providerInstanceType) ?? optionalTrimmedString(body.nativeOffering);
  const providerInstanceBootDiskSizeGb = optionalPositiveInteger(
    body.bootDiskSizeGb,
    'bootDiskSizeGb'
  );
  const providerInstanceImage = optionalTrimmedString(body.image) ?? null;
  const providerInstanceArchitecture = body.architecture ?? null;
  const allocation = await resolveCanonicalVmAllocationPlan(db, c.env, {
    entryPoint: 'direct-node',
    taskId: ulid(),
    userId,
    projectId: null,
    explicit: {
      vmSize: body.vmSize ?? DEFAULT_VM_SIZE,
      provider: provider ?? null,
      vmLocation,
      native: {
        providerInstanceType,
        providerInstanceBootDiskSizeGb,
        providerInstanceImage,
        providerInstanceArchitecture,
      },
    },
    credentialProjectPolicy: 'inherited-or-none',
    taskModeDefault: 'task',
    workloadRole: 'workspace',
    credentialsRequiredMessage:
      'Cloud provider credentials required. Connect your account in Settings.',
  });
  if ('error' in allocation) {
    if (allocation.errorKind === 'credentials') throw errors.forbidden(allocation.error);
    throw errors.badRequest(allocation.error);
  }
  if (
    allocation.quotaCredentialSource === 'platform' &&
    c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false'
  ) {
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
    credentialAttributionUserId: allocation.credentialAttributionUserId,
    credentialAttributionProjectId: allocation.credentialAttributionProjectId,
    credentialAttributionSource: allocation.credentialAttributionSource,
    name: body.name.trim(),
    vmSize: allocation.vmSize,
    vmLocation: allocation.vmLocation,
    cloudProvider: allocation.effectiveProvider,
    providerInstanceType: allocation.providerInstanceType,
    providerInstanceBootDiskSizeGb: allocation.providerInstanceBootDiskSizeGb,
    providerInstanceImage: allocation.providerInstanceImage,
    providerInstanceArchitecture: allocation.providerInstanceArchitecture,
    heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
    capacityPlacementSnapshot: allocation.capacityPlacementSnapshot,
  });

  recordNodeRoutingMetric(
    {
      metric: 'sc_006_node_efficiency',
      nodeId: created.id,
      userId,
      reusedExistingNode: false,
      nodeCountForUser: existingNodes.length + 1,
    },
    c.env
  );

  await scheduleDirectProvisioning(c.env, { nodeId: created.id, userId });
  return c.json(created, 201);
});

nodesRoutes.get('/:id', async (c) => {
  const db = drizzle(c.env.DATABASE, { schema });
  const node = await requireNodeOwnership(c, c.req.param('id'));
  if (!node) {
    throw errors.notFound('Node');
  }

  const refreshed = await refreshNodeHealth(db, node, c.env);
  const deploymentSummaries = await loadDeploymentEnvironmentSummaries(db, [refreshed.id]);
  return c.json(toNodeResponse(refreshed, deploymentSummaries.get(refreshed.id) ?? []));
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
    .where(and(eq(schema.workspaces.nodeId, nodeId), eq(schema.workspaces.userId, userId)));

  if (node.status === 'running' && node.healthStatus !== 'unhealthy') {
    for (const workspace of workspaceRows) {
      if (
        workspace.status === 'running' ||
        workspace.status === 'recovery' ||
        workspace.status === 'creating'
      ) {
        try {
          await stopWorkspaceOnNode(nodeId, workspace.id, c.env, userId);
        } catch (e) {
          log.warn('node.workspace_stop_before_power_off_failed', {
            nodeId,
            workspaceId: workspace.id,
            error: String(e),
          });
        }
      }
    }
  }

  await stopNodeResources(nodeId, userId, c.env);

  return c.json({ status: 'stopped' });
});

nodesRoutes.delete('/:id', deleteNodeRoute);

nodesRoutes.route('/', nodeDiagnosticsRoutes);

export { nodesRoutes };
