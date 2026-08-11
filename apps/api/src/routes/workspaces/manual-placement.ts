import type {
  CredentialProvider,
  CredentialSource,
  PlacementExplanation,
  VMSize,
} from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { type drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { errors } from '../../middleware/error';
import { waitForNodeAgentReady } from '../../services/node-agent';
import { selectNodeWithExplanation } from '../../services/node-selector';
import { createNodeRecord, provisionNode } from '../../services/nodes';
import {
  appendProvisioningAttempt,
  createPlacementExplanation,
  failPlacement,
  requireProvisioning,
  resolvePlacementRequest,
} from '../../services/placement-explanation';
import { resolveCredentialSource } from '../../services/provider-credentials';
import type { WorkspaceGitSourceProject } from '../../services/workspace-git-source';
import { scheduleWorkspaceCreateOnNode } from './_helpers';

type WorkspaceDb = ReturnType<typeof drizzle<typeof schema>>;

export interface ManualPlacementResult {
  nodeId: string;
  mustProvisionNode: boolean;
  credentialAttributionSource: CredentialSource;
  explanation: PlacementExplanation;
}

async function persistRejectedManualPlacement(
  db: WorkspaceDb,
  input: Pick<
    Parameters<typeof resolveManualWorkspacePlacement>[0],
    'projectId' | 'userId' | 'workspaceName' | 'now'
  >,
  explanation: PlacementExplanation,
  errorMessage: string
): Promise<void> {
  const taskId = ulid();
  await db.insert(schema.tasks).values({
    id: taskId,
    projectId: input.projectId,
    userId: input.userId,
    title: input.workspaceName,
    status: 'failed',
    taskMode: 'conversation',
    triggeredBy: 'user',
    credentialAttributionUserId: input.userId,
    credentialAttributionSource: 'user',
    placementExplanationJson: JSON.stringify(explanation),
    errorMessage,
    createdBy: input.userId,
    createdAt: input.now,
    updatedAt: input.now,
  });
  log.info('workspace.manual_placement_rejected', { taskId, placement: explanation });
}

export async function resolveManualWorkspacePlacement(input: {
  db: WorkspaceDb;
  env: Env;
  userId: string;
  projectId: string;
  workspaceName: string;
  vmSize: VMSize;
  vmLocation: string;
  preferredNodeId?: string;
  provider?: CredentialProvider;
  activeNodeCount: number;
  maxNodesPerUser: number;
  heartbeatStaleAfterSeconds: number;
  now: string;
}): Promise<ManualPlacementResult> {
  if (input.preferredNodeId) {
    const placement = await selectNodeWithExplanation(input.db, input.userId, input.env, {
      vmSize: input.vmSize,
      vmLocation: input.vmLocation,
      preferredNodeId: input.preferredNodeId,
      preferredOnly: true,
      selectionPath: 'manual',
    });
    if (placement.node) {
      return {
        nodeId: placement.node.id,
        mustProvisionNode: false,
        credentialAttributionSource: 'user',
        explanation: placement.explanation,
      };
    }

    await persistRejectedManualPlacement(
      input.db,
      input,
      placement.explanation,
      'Selected node is not eligible for workspace placement'
    );
    throw errors.badRequest('Selected node is not eligible for workspace placement');
  }

  const request = resolvePlacementRequest(input.env, input.vmSize, input.vmLocation);
  const provisioning = requireProvisioning(createPlacementExplanation(request, 'manual'));
  if (input.activeNodeCount >= input.maxNodesPerUser) {
    await persistRejectedManualPlacement(
      input.db,
      input,
      failPlacement(provisioning, 'node-limit'),
      `Maximum ${input.maxNodesPerUser} nodes allowed`
    );
    throw errors.badRequest(`Maximum ${input.maxNodesPerUser} nodes allowed`);
  }
  const credential = await resolveCredentialSource(
    input.db,
    input.userId,
    input.provider,
    input.projectId
  );
  if (!credential) {
    await persistRejectedManualPlacement(
      input.db,
      input,
      failPlacement(provisioning, 'credentials-unavailable'),
      'Cloud provider credentials required'
    );
    throw errors.forbidden(
      'Cloud provider credentials required. Connect your account in Settings.'
    );
  }
  let createdNode: Awaited<ReturnType<typeof createNodeRecord>>;
  try {
    createdNode = await createNodeRecord(input.env, {
      userId: input.userId,
      credentialAttributionUserId: input.userId,
      credentialAttributionProjectId:
        credential.credentialSource === 'project' ? input.projectId : null,
      credentialAttributionSource: credential.credentialSource,
      name: `${input.workspaceName} Node`,
      vmSize: input.vmSize,
      vmLocation: input.vmLocation,
      cloudProvider: input.provider ?? credential.providerName,
      heartbeatStaleAfterSeconds: input.heartbeatStaleAfterSeconds,
    });
  } catch (error) {
    await persistRejectedManualPlacement(
      input.db,
      input,
      failPlacement(provisioning, 'provider-failed'),
      'Node provisioning could not be started'
    );
    throw error;
  }
  return {
    nodeId: createdNode.id,
    mustProvisionNode: true,
    credentialAttributionSource: credential.credentialSource,
    explanation: appendProvisioningAttempt(
      provisioning,
      { vmSize: input.vmSize, vmLocation: input.vmLocation, outcome: 'started' },
      createdNode.id
    ),
  };
}

export async function completeManualWorkspacePlacement(input: {
  env: Env;
  explanation: PlacementExplanation;
  mustProvisionNode: boolean;
  nodeId: string;
  workspaceId: string;
  taskId: string;
  userId: string;
  repository: string;
  branch: string;
  project: WorkspaceGitSourceProject;
  vmSize: VMSize;
  vmLocation: string;
  gitUserName?: string | null;
  gitUserEmail?: string | null;
}): Promise<void> {
  const { drizzle: createDrizzle } = await import('drizzle-orm/d1');
  const db = createDrizzle(input.env.DATABASE, { schema });
  let explanation = input.explanation;
  const persist = async (): Promise<void> => {
    const updatedAt = new Date().toISOString();
    const json = JSON.stringify(explanation);
    await db
      .update(schema.workspaces)
      .set({ placementExplanationJson: json, updatedAt })
      .where(eq(schema.workspaces.id, input.workspaceId));
    await db
      .update(schema.tasks)
      .set({ placementExplanationJson: json, updatedAt })
      .where(eq(schema.tasks.id, input.taskId));
  };
  const persistFailure = async (errorMessage: string): Promise<void> => {
    await persist();
    const updatedAt = new Date().toISOString();
    await db
      .update(schema.workspaces)
      .set({ status: 'error', errorMessage, updatedAt })
      .where(eq(schema.workspaces.id, input.workspaceId));
    await db
      .update(schema.tasks)
      .set({ status: 'failed', errorMessage, updatedAt })
      .where(eq(schema.tasks.id, input.taskId));
  };

  if (input.mustProvisionNode) {
    try {
      await provisionNode(input.nodeId, input.env);
    } catch {
      explanation = appendProvisioningAttempt(
        explanation,
        {
          vmSize: input.vmSize,
          vmLocation: input.vmLocation,
          outcome: 'failed',
          failureReason: 'provider-failed',
        },
        input.nodeId
      );
      await persistFailure('Node provisioning failed');
      return;
    }

    const [node] = await db
      .select({ status: schema.nodes.status, errorMessage: schema.nodes.errorMessage })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, input.nodeId))
      .limit(1);
    if (!node || node.status !== 'running') {
      explanation = appendProvisioningAttempt(
        explanation,
        {
          vmSize: input.vmSize,
          vmLocation: input.vmLocation,
          outcome: 'failed',
          failureReason: 'node-unavailable',
        },
        input.nodeId
      );
      await persistFailure(node?.errorMessage || 'Node provisioning failed');
      return;
    }

    explanation = appendProvisioningAttempt(
      explanation,
      { vmSize: input.vmSize, vmLocation: input.vmLocation, outcome: 'succeeded' },
      input.nodeId
    );
    await persist();
    try {
      await waitForNodeAgentReady(input.nodeId, input.env);
    } catch {
      explanation = appendProvisioningAttempt(
        explanation,
        {
          vmSize: input.vmSize,
          vmLocation: input.vmLocation,
          outcome: 'failed',
          failureReason: 'readiness-timeout',
        },
        input.nodeId
      );
      await persistFailure('Node agent not reachable after provisioning');
      return;
    }
  } else {
    // The create route writes the initial decision to both records. Repeat that
    // write at the async boundary so every successful reusable path has the
    // same finalized persistence guarantee as provisioning paths.
    await persist();
  }

  await scheduleWorkspaceCreateOnNode(
    input.env,
    input.workspaceId,
    input.nodeId,
    input.userId,
    input.repository,
    input.branch,
    input.project,
    input.gitUserName,
    input.gitUserEmail
  );
}
