import {
  type CapacityPlacementSnapshot,
  type CredentialSource,
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  type ResolvedResourceReservation,
} from '@simple-agent-manager/shared';
import { and, count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { type Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { toWorkspaceResponse } from '../../lib/mappers';
import { ulid } from '../../lib/ulid';
import { getAuth, requireApproved, requireAuth } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireProjectCapability } from '../../middleware/project-auth';
import { CreateWorkspaceSchema, jsonValidator } from '../../schemas';
import {
  type CanonicalVmAllocationPlan,
  placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan,
} from '../../services/canonical-vm-allocation';
import { capacityPlacementSnapshotDbValues } from '../../services/capacity-placement-snapshot';
import { toCapacityPlacementSnapshot } from '../../services/capacity-pools';
import { scheduleDirectProvisioning } from '../../services/direct-provisioning';
import { getRuntimeLimits } from '../../services/limits';
import { isNodeAgentVersionCompatible } from '../../services/node-agent-compatibility';
import {
  assertNodeAllocationPlanCurrent,
  createNodeRecord,
} from '../../services/nodes';
import {
  PlacementResolutionError,
  resolveTaskStartPlacement,
} from '../../services/placement-resolver';
import * as projectDataService from '../../services/project-data';
import { recordNodeRoutingMetric } from '../../services/telemetry';
import { resolveUniqueWorkspaceDisplayName } from '../../services/workspace-names';
import {
  reserveWorkspacePlacement,
} from '../../services/workspace-placement';
import { resolveWorkspaceAdmissionPolicy } from '../../services/workspace-resource-capacity';
import { requireRepositoryUserAccess } from '../projects/_helpers';
import { getOwnedNode, getOwnedWorkspace } from './_helpers';
import {
  normalizeCredentialSource,
  optionalPositiveInteger,
  optionalTrimmedString,
  startComputeTrackingForNode,
} from './workspace-create-helpers';

export function registerWorkspaceCreateRoute(crudRoutes: Hono<{ Bindings: Env }>): void {
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

      const linkedProject = await requireProjectCapability(
        db,
        projectId,
        userId,
        'workspace:write'
      );
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
      let workspaceProviderInstanceArchitecture: string | null =
        providerInstanceArchitecture ?? null;
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
              vmSize: body.vmSize,
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
            vmSize: body.vmSize,
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

      await scheduleDirectProvisioning(c.env, {
        nodeId: targetNodeId,
        userId,
        workspace: {
          placement: {
            id: workspaceId, nodeId: targetNodeId, projectId: linkedProject.id, userId,
            installationId: resolvedInstallationId, name: workspaceName,
            displayName: uniqueName.displayName, normalizedDisplayName: uniqueName.normalizedDisplayName,
            repository: resolvedRepository, branch, vmSize: workspaceVmSize, vmLocation: workspaceVmLocation,
            workspaceProfile: DEFAULT_WORKSPACE_PROFILE, devcontainerConfigName: null, agentProfileHint: null,
            resourceRequirementsJson, capacityPlacementSnapshot, authorityNodeClass, resolvedReservation, createdAt: now,
          },
          linkedProject: { id: linkedProject.id, repoProvider: linkedProject.repoProvider },
          taskId: chatTaskId, chatSessionId, mustProvisionNode,
          gitUserName: auth.user.name ?? null, gitUserEmail: auth.user.email ?? null,
        },
      });

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
}
