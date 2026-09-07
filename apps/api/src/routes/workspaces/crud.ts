import {
  type CapacityPlacementSnapshot,
  type CredentialSource,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  type ResolvedResourceReservation,
  type WorkspaceStatus,
} from '@simple-agent-manager/shared';
import { and, count, desc, eq, inArray, ne } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toWorkspaceResponse } from '../../lib/mappers';
import { ulid } from '../../lib/ulid';
import { getAuth, getUserId, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import {
  CreateWorkspaceSchema,
  jsonValidator,
  UpdateWorkspacePortsPublicSchema,
  UpdateWorkspaceSchema,
} from '../../schemas';
import {
  type CanonicalVmAllocationPlan,
  placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan,
} from '../../services/canonical-vm-allocation';
import { capacityPlacementSnapshotDbValues } from '../../services/capacity-placement-snapshot';
import { toCapacityPlacementSnapshot } from '../../services/capacity-pools';
import { startComputeTracking } from '../../services/compute-usage';
import { signPortAccessToken } from '../../services/jwt';
import { getRuntimeLimits } from '../../services/limits';
import {
  getWorkspacePortsOnNode,
  NodeAgentFetchError,
  NodeAgentHttpError,
  waitForNodeAgentReady,
} from '../../services/node-agent';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  assertNodeAllocationPlanCurrent,
  createNodeRecord,
  provisionNode,
} from '../../services/nodes';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
} from '../../services/placement-resolver';
import * as projectDataService from '../../services/project-data';
import {
  assertDirectWorkspaceProvisioningAuthority,
  cleanupFreshProvisioningNode,
} from '../../services/provisioning-authority';
import { recordNodeRoutingMetric } from '../../services/telemetry';
import { cleanupWorkspaceForDeletion } from '../../services/workspace-cleanup';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import {
  attachPrecreatedWorkspacePlacement,
  reserveWorkspacePlacement,
} from '../../services/workspace-placement';
import { resolveWorkspaceAdmissionPolicy } from '../../services/workspace-resource-capacity';
import { requireRepositoryUserAccess } from '../projects/_helpers';
import { getOwnedNode, getOwnedWorkspace, scheduleWorkspaceCreateOnNode } from './_helpers';
import {
  isExpectedWorkspacePortsUpstreamUnavailable,
  workspacePortsReadinessPayload,
  workspacePortsReadinessStatus,
  workspacePortsStateForStatus,
} from './ports-readiness';

const crudRoutes = new Hono<{ Bindings: Env }>();

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

function normalizeCredentialSource(value: string | null | undefined): CredentialSource | null {
  return value === 'user' || value === 'project' || value === 'platform' || value === 'self-hosted'
    ? value
    : null;
}

async function startComputeTrackingForNode(
  db: Parameters<typeof startComputeTracking>[0],
  input: {
    userId: string;
    workspaceId: string;
    nodeId: string;
    vmSize: string;
  }
): Promise<void> {
  try {
    const [nodeRow] = await db
      .select({
        cloudProvider: schema.nodes.cloudProvider,
        credentialSource: schema.nodes.credentialSource,
        providerInstanceType: schema.nodes.providerInstanceType,
        providerInstanceVcpuCount: schema.nodes.providerInstanceVcpuCount,
        providerInstanceMemoryMb: schema.nodes.providerInstanceMemoryMb,
        providerInstanceDiskGb: schema.nodes.providerInstanceDiskGb,
        providerInstanceBootDiskSizeGb: schema.nodes.providerInstanceBootDiskSizeGb,
        providerInstanceImage: schema.nodes.providerInstanceImage,
        providerInstanceArchitecture: schema.nodes.providerInstanceArchitecture,
        observedProviderInstanceType: schema.nodes.observedProviderInstanceType,
        observedProviderInstanceVcpuCount: schema.nodes.observedProviderInstanceVcpuCount,
        observedProviderInstanceMemoryMb: schema.nodes.observedProviderInstanceMemoryMb,
        observedProviderInstanceDiskGb: schema.nodes.observedProviderInstanceDiskGb,
        observedHardwareJson: schema.nodes.observedHardwareJson,
        observedHardwareSource: schema.nodes.observedHardwareSource,
        providerInstancePriceDisplay: schema.nodes.providerInstancePriceDisplay,
        providerInstancePriceCurrency: schema.nodes.providerInstancePriceCurrency,
        providerInstancePriceMonthlyCents: schema.nodes.providerInstancePriceMonthlyCents,
        providerInstancePriceHourlyMicros: schema.nodes.providerInstancePriceHourlyMicros,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, input.nodeId))
      .limit(1);

    await startComputeTracking(db, {
      userId: input.userId,
      workspaceId: input.workspaceId,
      nodeId: input.nodeId,
      vmSize: input.vmSize,
      cloudProvider: nodeRow?.cloudProvider,
      providerInstanceType: nodeRow?.providerInstanceType,
      providerInstanceVcpuCount: nodeRow?.providerInstanceVcpuCount,
      providerInstanceMemoryMb: nodeRow?.providerInstanceMemoryMb,
      providerInstanceDiskGb: nodeRow?.providerInstanceDiskGb,
      providerInstanceBootDiskSizeGb: nodeRow?.providerInstanceBootDiskSizeGb,
      providerInstanceImage: nodeRow?.providerInstanceImage,
      providerInstanceArchitecture: nodeRow?.providerInstanceArchitecture,
      observedProviderInstanceType: nodeRow?.observedProviderInstanceType,
      observedProviderInstanceVcpuCount: nodeRow?.observedProviderInstanceVcpuCount,
      observedProviderInstanceMemoryMb: nodeRow?.observedProviderInstanceMemoryMb,
      observedProviderInstanceDiskGb: nodeRow?.observedProviderInstanceDiskGb,
      observedHardwareJson: nodeRow?.observedHardwareJson,
      observedHardwareSource: nodeRow?.observedHardwareSource,
      providerInstancePriceDisplay: nodeRow?.providerInstancePriceDisplay,
      providerInstancePriceCurrency: nodeRow?.providerInstancePriceCurrency,
      providerInstancePriceMonthlyCents: nodeRow?.providerInstancePriceMonthlyCents,
      providerInstancePriceHourlyMicros: nodeRow?.providerInstancePriceHourlyMicros,
      credentialSource: (nodeRow?.credentialSource as CredentialSource) ?? 'user',
    });
  } catch (err) {
    log.error('workspace.compute_tracking_start_failed', {
      workspaceId: input.workspaceId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

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
    .select()
    .from(schema.workspaces)
    .where(and(...conditions))
    .orderBy(desc(schema.workspaces.createdAt));

  return c.json(rows.map((workspace) => toWorkspaceResponse(workspace, c.env.BASE_DOMAIN)));
});

crudRoutes.get('/:id', requireAuth(), requireApproved(), async (c) => {
  const userId = getUserId(c);
  const workspaceId = c.req.param('id');
  const db = drizzle(c.env.DATABASE, { schema });

  const workspace = await getOwnedWorkspace(db, workspaceId, userId);
  const response = toWorkspaceResponse(workspace, c.env.BASE_DOMAIN);

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

crudRoutes.post(
  '/',
  requireAuth(),
  requireApproved(),
  jsonValidator(CreateWorkspaceSchema),
  async (c) => {
    const auth = getAuth(c);
    const userId = auth.user.id;
    const db = drizzle(c.env.DATABASE, { schema });
    const body = c.req.valid('json');
    const now = new Date().toISOString();
    const limits = getRuntimeLimits(c.env);
    const projectId = body.projectId?.trim();
    const workspaceName = body.name?.trim();

    if (!workspaceName) {
      throw errors.badRequest('name is required');
    }

    if (!projectId) {
      throw errors.badRequest('projectId is required');
    }

    const linkedProject = await requireProjectCapability(db, projectId, userId, 'workspace:write');
    const resolvedInstallationId = linkedProject.installationId;
    const resolvedRepository = linkedProject.repository;
    const resolvedBranch = body.branch?.trim() || linkedProject.defaultBranch;

    if (!resolvedRepository || !resolvedInstallationId) {
      throw errors.badRequest('repository and installationId are required');
    }
    const normalizedRepository = resolvedRepository.toLowerCase();

    // Fail-fast user∩app GitHub repo-access gate. Re-verify the user still has
    // access to the bound repository through the app installation BEFORE
    // provisioning any node or creating any workspace. Throws 403 if access was
    // revoked or the repository id drifted. Also covers installation ownership
    // (via requireOwnedInstallation), so no separate ownership query is needed.
    await requireRepositoryUserAccess(c, db, linkedProject, userId);

    const vmSize = body.vmSize ?? DEFAULT_VM_SIZE;
    const vmLocation = body.vmLocation ?? DEFAULT_VM_LOCATION;
    const providerInstanceType =
      optionalTrimmedString(body.providerInstanceType) ??
      optionalTrimmedString(body.nativeOffering);
    const providerInstanceBootDiskSizeGb = optionalPositiveInteger(
      body.bootDiskSizeGb,
      'bootDiskSizeGb'
    );
    const providerInstanceImage = optionalTrimmedString(body.image) ?? null;
    const providerInstanceArchitecture = body.architecture ?? null;
    const resourceRequirementsJson = body.resourceRequirements
      ? JSON.stringify(body.resourceRequirements)
      : null;
    const allocationTaskId = ulid();
    const projectDefaults = placementProjectDefaultsFromRow(linkedProject);
    let nodeId = body.nodeId;
    let mustProvisionNode = false;
    let credentialAttributionUserId = userId;
    let credentialAttributionProjectId: string | null = null;
    let credentialAttributionSource: CredentialSource = 'user';
    let capacityPlacementSnapshot: CapacityPlacementSnapshot | null = null;
    let workspaceVmSize = vmSize;
    let workspaceVmLocation = vmLocation;
    let workspaceProviderInstanceType: string | null = providerInstanceType ?? null;
    let workspaceProviderInstanceBootDiskSizeGb: number | null =
      providerInstanceBootDiskSizeGb ?? null;
    let workspaceProviderInstanceImage: string | null = providerInstanceImage;
    let workspaceProviderInstanceArchitecture: string | null = providerInstanceArchitecture ?? null;
    let requestedVmSizeSource: string | null = null;
    let resolvedReservation: ResolvedResourceReservation;
    let freshAllocation: CanonicalVmAllocationPlan | null = null;
    let authorityNodeClass: 'managed' | 'user-owned' = 'managed';

    if (nodeId) {
      try {
        const placement = resolveTaskStartPlacement({
          entryPoint: 'direct-workspace',
          taskId: allocationTaskId,
          userId,
          projectId: linkedProject.id,
          project: projectDefaults,
          explicit: {
            vmSize,
            provider: body.provider ?? null,
            vmLocation,
          },
          credentialProjectPolicy: 'current-project',
          taskModeDefault: 'workspace-profile',
          resourceRequirements: body.resourceRequirements
            ? { task: body.resourceRequirements }
            : undefined,
          workloadRole: 'workspace',
        });
        resolvedReservation = placement.resolvedReservation;
        requestedVmSizeSource = placement.vmSizeSource;
      } catch (err) {
        if (err instanceof PlacementResolutionError) {
          throw errors.badRequest(err.message);
        }
        throw err;
      }
    } else {
      const allocation = await resolveCanonicalVmAllocationPlan(db, c.env, {
        entryPoint: 'direct-workspace',
        taskId: allocationTaskId,
        userId,
        projectId: linkedProject.id,
        project: projectDefaults,
        explicit: {
          vmSize,
          provider: body.provider ?? null,
          vmLocation,
          native: {
            providerInstanceType,
            providerInstanceBootDiskSizeGb,
            providerInstanceImage,
            providerInstanceArchitecture,
          },
        },
        credentialProjectPolicy: 'current-project',
        taskModeDefault: 'workspace-profile',
        resourceRequirements: body.resourceRequirements
          ? { task: body.resourceRequirements }
          : undefined,
        workloadRole: 'workspace',
        credentialsRequiredMessage:
          'Cloud provider credentials required. Connect your account in Settings.',
      });
      if ('error' in allocation) {
        if (allocation.errorKind === 'credentials') throw errors.forbidden(allocation.error);
        throw errors.badRequest(allocation.error);
      }
      freshAllocation = allocation;
      resolvedReservation = allocation.placement.resolvedReservation;
      requestedVmSizeSource = allocation.placement.vmSizeSource;
      credentialAttributionUserId = allocation.credentialAttributionUserId;
      credentialAttributionProjectId = allocation.credentialAttributionProjectId;
      credentialAttributionSource = allocation.credentialAttributionSource;
      capacityPlacementSnapshot = allocation.capacityPlacementSnapshot;
      workspaceVmSize = allocation.vmSize;
      workspaceVmLocation = allocation.vmLocation;
      workspaceProviderInstanceType = allocation.providerInstanceType;
      workspaceProviderInstanceBootDiskSizeGb = allocation.providerInstanceBootDiskSizeGb;
      workspaceProviderInstanceImage = allocation.providerInstanceImage;
      workspaceProviderInstanceArchitecture = allocation.providerInstanceArchitecture;
    }

    // Validate branch name — reject shell metacharacters to prevent command injection.
    // Git branch names allow: alphanumeric, hyphens, underscores, slashes, dots.
    // See INJ-VULN-02 in Shannon security assessment.
    const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9._\-/]+$/;
    if (!SAFE_BRANCH_PATTERN.test(resolvedBranch)) {
      throw errors.badRequest(
        'branch contains invalid characters. Only alphanumeric, hyphens, underscores, slashes, and dots are allowed.'
      );
    }
    const branch = resolvedBranch;

    // Use COUNT instead of fetching all node IDs (P1 fix).
    // Exclude deleted/stopped nodes — only active ones count toward the limit.
    const [userNodeCount] = await db
      .select({ count: count() })
      .from(schema.nodes)
      .where(
        and(
          eq(schema.nodes.userId, userId),
          inArray(schema.nodes.status, ['running', 'creating', 'recovery']),
          eq(schema.nodes.nodeRole, 'workspace')
        )
      );
    const userNodeCountVal = userNodeCount?.count ?? 0;

    if (nodeId) {
      const node = await getOwnedNode(db, nodeId, userId);
      if (node.status !== 'running' || node.healthStatus === 'unhealthy') {
        throw errors.badRequest('Selected node is not ready for workspace creation');
      }
      if (
        node.runtime !== 'vm' ||
        node.nodeRole !== 'workspace' ||
        (node.workloadRole ?? 'workspace') !== 'workspace'
      ) {
        throw errors.badRequest('Selected node is not eligible for workspace creation');
      }
      if (!isNodeAgentVersionCompatible(node.agentVersion, c.env.VM_AGENT_REQUIRED_VERSION)) {
        throw errors.badRequest('Selected node is running an incompatible VM agent build');
      }
      if (body.provider && node.cloudProvider !== body.provider) {
        throw errors.badRequest('Selected node does not match the requested provider');
      }
      if (body.vmLocation && node.vmLocation !== vmLocation) {
        throw errors.badRequest('Selected node does not match the requested VM location');
      }
      if (providerInstanceType && node.providerInstanceType !== providerInstanceType) {
        throw errors.badRequest('Selected node does not match the requested native offering');
      }
      if (
        providerInstanceBootDiskSizeGb !== undefined &&
        node.providerInstanceBootDiskSizeGb !== providerInstanceBootDiskSizeGb
      ) {
        throw errors.badRequest('Selected node does not match the requested boot disk size');
      }
      if (providerInstanceImage && node.providerInstanceImage !== providerInstanceImage) {
        throw errors.badRequest('Selected node does not match the requested image');
      }
      if (
        providerInstanceArchitecture &&
        node.providerInstanceArchitecture !== providerInstanceArchitecture
      ) {
        throw errors.badRequest('Selected node does not match the requested architecture');
      }
      authorityNodeClass = node.nodeClass === 'user-owned' ? 'user-owned' : 'managed';
      if (authorityNodeClass === 'managed') {
        await assertNodeAllocationPlanCurrent(c.env, nodeId, userId, linkedProject.id);
        const nodeSnapshot = toCapacityPlacementSnapshot(node);
        capacityPlacementSnapshot = nodeSnapshot.capacityPoolId ? nodeSnapshot : null;
      } else {
        capacityPlacementSnapshot = null;
      }
      credentialAttributionUserId = node.credentialAttributionUserId ?? userId;
      credentialAttributionSource =
        normalizeCredentialSource(node.credentialAttributionSource) ??
        normalizeCredentialSource(node.credentialSource) ??
        (authorityNodeClass === 'user-owned' ? 'self-hosted' : 'user');
      credentialAttributionProjectId =
        credentialAttributionSource === 'project'
          ? (node.credentialAttributionProjectId ?? linkedProject.id)
          : null;
      workspaceVmSize = node.vmSize as typeof workspaceVmSize;
      workspaceVmLocation = node.vmLocation;
      workspaceProviderInstanceType = node.providerInstanceType;
      workspaceProviderInstanceBootDiskSizeGb = node.providerInstanceBootDiskSizeGb;
      workspaceProviderInstanceImage = node.providerInstanceImage;
      workspaceProviderInstanceArchitecture = node.providerInstanceArchitecture;
    } else {
      const allocation = freshAllocation;
      if (!allocation) {
        throw errors.internal('Failed to resolve node allocation');
      }
      if (userNodeCountVal >= limits.maxNodesPerUser) {
        throw errors.badRequest(`Maximum ${limits.maxNodesPerUser} nodes allowed`);
      }
      if (
        allocation.quotaCredentialSource === 'platform' &&
        c.env.COMPUTE_QUOTA_ENFORCEMENT_ENABLED !== 'false'
      ) {
        const { checkQuotaForUser } = await import('../../services/compute-quotas');
        const quotaCheck = await checkQuotaForUser(db, userId);
        if (!quotaCheck.allowed) {
          throw errors.forbidden(
            `Monthly compute quota exceeded. You've used ${quotaCheck.used} of ${quotaCheck.limit} vCPU-hours this month. ` +
              'Add your own cloud provider credentials in Settings or contact your admin to increase your quota.'
          );
        }
      }

      const createdNode = await createNodeRecord(c.env, {
        userId,
        credentialAttributionUserId,
        credentialAttributionProjectId,
        credentialAttributionSource,
        name: `${workspaceName} Node`,
        vmSize: allocation.vmSize,
        vmLocation: allocation.vmLocation,
        cloudProvider: allocation.effectiveProvider,
        providerInstanceType: allocation.providerInstanceType,
        providerInstanceBootDiskSizeGb: allocation.providerInstanceBootDiskSizeGb,
        providerInstanceImage: allocation.providerInstanceImage,
        providerInstanceArchitecture: allocation.providerInstanceArchitecture,
        heartbeatStaleAfterSeconds: limits.nodeHeartbeatStaleSeconds,
        capacityPlacementSnapshot,
      });

      nodeId = createdNode.id;
      mustProvisionNode = true;
    }
    const targetNodeId = nodeId;
    if (!targetNodeId) {
      throw errors.internal('Failed to determine target node');
    }

    // Count active workspaces on this node (for telemetry — no hard count limit,
    // resource thresholds handle capacity in the task runner path).
    const [nodeWorkspaceCount] = await db
      .select({ count: count() })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.userId, userId),
          eq(schema.workspaces.nodeId, targetNodeId),
          inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
        )
      );
    const nodeWorkspaceCountVal = nodeWorkspaceCount?.count ?? 0;

    const uniqueName = await resolveUniqueWorkspaceDisplayName(db, targetNodeId, workspaceName);

    const workspaceId = ulid();

    const admissionPolicy = resolveWorkspaceAdmissionPolicy(c.env);
    if (mustProvisionNode) {
      await db.insert(schema.workspaces).values({
        id: workspaceId,
        nodeId: null,
        projectId: linkedProject.id,
        userId,
        installationId: resolvedInstallationId,
        name: workspaceName,
        displayName: uniqueName.displayName,
        normalizedDisplayName: uniqueName.normalizedDisplayName,
        repository: resolvedRepository,
        branch,
        status: 'creating',
        vmSize: workspaceVmSize,
        vmLocation: workspaceVmLocation,
        providerInstanceType: workspaceProviderInstanceType,
        providerInstanceBootDiskSizeGb: workspaceProviderInstanceBootDiskSizeGb,
        providerInstanceImage: workspaceProviderInstanceImage,
        providerInstanceArchitecture: workspaceProviderInstanceArchitecture,
        resourceRequirementsJson,
        resolvedReservationJson: JSON.stringify(resolvedReservation),
        createdAt: now,
        updatedAt: now,
      });
    } else {
      const placementReserved = await reserveWorkspacePlacement(
        c.env.DATABASE,
        {
          id: workspaceId,
          nodeId: targetNodeId,
          projectId: linkedProject.id,
          userId,
          installationId: resolvedInstallationId,
          name: workspaceName,
          displayName: uniqueName.displayName,
          normalizedDisplayName: uniqueName.normalizedDisplayName,
          repository: resolvedRepository,
          branch,
          vmSize: workspaceVmSize,
          vmLocation: workspaceVmLocation,
          workspaceProfile: DEFAULT_WORKSPACE_PROFILE,
          devcontainerConfigName: null,
          agentProfileHint: null,
          resourceRequirementsJson,
          capacityPlacementSnapshot,
          authorityNodeClass,
          resolvedReservation,
          createdAt: now,
        },
        admissionPolicy
      );
      if (!placementReserved) {
        throw errors.conflict(
          'Selected node lost capacity or placement authority before workspace creation'
        );
      }
    }

    const chatTaskId = ulid();
    await db.insert(schema.tasks).values({
      id: chatTaskId,
      projectId: linkedProject.id,
      userId,
      workspaceId,
      title: workspaceName,
      status: 'queued',
      executionStep: 'workspace_creation',
      taskMode: 'conversation',
      triggeredBy: 'user',
      credentialAttributionUserId,
      credentialAttributionProjectId,
      credentialAttributionSource,
      requestedVmSize: workspaceVmSize,
      requestedVmSizeSource,
      resourceRequirementsJson,
      resourceRequirementsSource: resourceRequirementsJson ? 'task' : null,
      resolvedReservationJson: JSON.stringify(resolvedReservation),
      ...capacityPlacementSnapshotDbValues(capacityPlacementSnapshot),
      createdBy: userId,
      createdAt: now,
      updatedAt: now,
    });

    // Create chat session in ProjectData DO (workspace always linked to project)
    let chatSessionId: string | null = null;
    try {
      chatSessionId = await projectDataService.createSession(
        c.env,
        linkedProject.id,
        workspaceId,
        workspaceName,
        chatTaskId,
        userId
      );
      await db
        .update(schema.workspaces)
        .set({ chatSessionId, updatedAt: now })
        .where(eq(schema.workspaces.id, workspaceId));
      await db
        .update(schema.tasks)
        .set({
          chatSessionId,
          status: 'in_progress',
          executionStep: 'workspace_ready',
          updatedAt: now,
        })
        .where(eq(schema.tasks.id, chatTaskId));
    } catch (err) {
      // Best-effort: session creation failure should not block workspace creation
      log.error('workspace.chat_session_create_failed', {
        workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const assertDirectWorkspacePlaceholderAuthority = async () => {
      await assertDirectWorkspaceProvisioningAuthority(c.env, {
        workspaceId,
        taskId: chatTaskId,
        userId,
        projectId: linkedProject.id,
        expectedNodeId: null,
        chatSessionId,
      });
    };

    const assertDirectWorkspaceDispatchAuthority = async () => {
      await assertDirectWorkspaceProvisioningAuthority(c.env, {
        workspaceId,
        taskId: chatTaskId,
        userId,
        projectId: linkedProject.id,
        expectedNodeId: targetNodeId,
        chatSessionId,
      });
    };

    const nodeCountForUser = userNodeCountVal + (mustProvisionNode ? 1 : 0);
    const reusedExistingNode = !mustProvisionNode;
    const workspaceCountOnNodeBefore = nodeWorkspaceCountVal;

    recordNodeRoutingMetric(
      {
        metric: 'sc_002_workspace_creation_flow',
        nodeId: targetNodeId,
        workspaceId,
        userId,
        repository: normalizedRepository,
        reusedExistingNode,
        workspaceCountOnNodeBefore,
        nodeCountForUser,
      },
      c.env
    );

    recordNodeRoutingMetric(
      {
        metric: 'sc_006_node_efficiency',
        nodeId: targetNodeId,
        workspaceId,
        userId,
        repository: normalizedRepository,
        reusedExistingNode,
        nodeCountForUser,
      },
      c.env
    );

    if (!mustProvisionNode && authorityNodeClass !== 'user-owned') {
      // Existing nodes already carry provider metadata; meter before scheduling work onto them.
      await startComputeTrackingForNode(db, {
        userId,
        workspaceId,
        nodeId: targetNodeId,
        vmSize: workspaceVmSize,
      });
    }

    c.executionCtx.waitUntil(
      (async () => {
        const innerDb = drizzle(c.env.DATABASE, { schema });
        const markDirectWorkspaceProvisioningFailed = async (message: string) => {
          const failedAt = new Date().toISOString();
          const workspaceFailed = await c.env.DATABASE.prepare(
            `UPDATE workspaces
                SET status = 'error',
                    error_message = ?,
                    updated_at = ?
              WHERE id = ?
                AND user_id = ?
                AND project_id = ?
                AND node_id IS NULL
                AND chat_session_id IS ?
                AND status = 'creating'
                AND runtime_deletion_confirmed_at IS NULL`
          )
            .bind(message, failedAt, workspaceId, userId, linkedProject.id, chatSessionId)
            .run();
          if ((workspaceFailed.meta?.changes ?? 0) !== 1) return;
          await c.env.DATABASE.prepare(
            `UPDATE tasks
                SET status = 'failed',
                    execution_step = 'workspace_creation',
                    error_message = ?,
                    completed_at = ?,
                    updated_at = ?
              WHERE id = ?
                AND workspace_id = ?
                AND user_id = ?
                AND project_id = ?
                AND status IN ('queued', 'in_progress')
                AND task_mode = 'conversation'
                AND triggered_by = 'user'`
          )
            .bind(message, failedAt, failedAt, chatTaskId, workspaceId, userId, linkedProject.id)
            .run();
        };
        if (mustProvisionNode) {
          await provisionNode(
            targetNodeId,
            c.env,
            chatSessionId
              ? {
                  projectId: linkedProject.id,
                  chatSessionId,
                  taskId: chatTaskId,
                  taskMode: 'conversation',
                }
              : undefined,
            {
              authorityProjectId: linkedProject.id,
              assertExternalMutationAuthority: assertDirectWorkspacePlaceholderAuthority,
            }
          );

          const nodeRows = await innerDb
            .select({
              status: schema.nodes.status,
              errorMessage: schema.nodes.errorMessage,
            })
            .from(schema.nodes)
            .where(eq(schema.nodes.id, targetNodeId))
            .limit(1);

          const provisionedNode = nodeRows[0];
          if (!provisionedNode || provisionedNode.status !== 'running') {
            await cleanupFreshProvisioningNode(c.env, {
              nodeId: targetNodeId,
              userId,
              nodeRole: 'workspace',
              reason: 'direct_workspace_node_not_running',
            });
            await markDirectWorkspaceProvisioningFailed(
              provisionedNode?.errorMessage || 'Node provisioning failed'
            );
            return;
          }

          const placementAttached = await attachPrecreatedWorkspacePlacement(
            c.env.DATABASE,
            {
              id: workspaceId,
              nodeId: targetNodeId,
              projectId: linkedProject.id,
              userId,
              installationId: resolvedInstallationId,
              name: workspaceName,
              displayName: uniqueName.displayName,
              normalizedDisplayName: uniqueName.normalizedDisplayName,
              repository: resolvedRepository,
              branch,
              vmSize: workspaceVmSize,
              vmLocation: workspaceVmLocation,
              workspaceProfile: DEFAULT_WORKSPACE_PROFILE,
              devcontainerConfigName: null,
              agentProfileHint: null,
              resourceRequirementsJson,
              capacityPlacementSnapshot,
              authorityNodeClass,
              resolvedReservation,
              createdAt: now,
            },
            admissionPolicy
          );
          if (!placementAttached) {
            await cleanupFreshProvisioningNode(c.env, {
              nodeId: targetNodeId,
              userId,
              nodeRole: 'workspace',
              reason: 'direct_workspace_final_admission_failed',
            });
            await markDirectWorkspaceProvisioningFailed(
              'Node lost capacity or placement authority before workspace creation'
            );
            return;
          }

          try {
            await waitForNodeAgentReady(targetNodeId, c.env);
          } catch (err) {
            await innerDb
              .update(schema.workspaces)
              .set({
                status: 'error',
                errorMessage:
                  err instanceof Error
                    ? err.message
                    : 'Node agent not reachable after provisioning',
                updatedAt: new Date().toISOString(),
              })
              .where(eq(schema.workspaces.id, workspaceId));
            return;
          }

          // Newly provisioned nodes only have provider-native capacity and price metadata
          // after provisioning finishes. Start metering after that point so compute_usage
          // records providerInstance* values instead of legacy vmSize fallbacks.
          await startComputeTrackingForNode(innerDb, {
            userId,
            workspaceId,
            nodeId: targetNodeId,
            vmSize: workspaceVmSize,
          });
        }

        await scheduleWorkspaceCreateOnNode(
          c.env,
          workspaceId,
          targetNodeId,
          userId,
          resolvedRepository,
          branch,
          linkedProject,
          auth.user.name,
          auth.user.email,
          { beforeExternalMutation: assertDirectWorkspaceDispatchAuthority }
        );
      })()
    );

    const created = await getOwnedWorkspace(db, workspaceId, userId);

    // Record activity event for workspace creation
    c.executionCtx.waitUntil(
      projectDataService
        .recordActivityEvent(
          c.env,
          linkedProject.id,
          'workspace.created',
          'user',
          userId,
          workspaceId,
          null,
          null,
          { name: created.name, repository: resolvedRepository }
        )
        .catch((e) => {
          log.warn('workspace.activity_created_failed', { workspaceId, error: String(e) });
        })
    );

    return c.json(toWorkspaceResponse(created, c.env.BASE_DOMAIN), 201);
  }
);

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
