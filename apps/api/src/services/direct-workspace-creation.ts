import { DEFAULT_WORKSPACE_PROFILE } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { scheduleWorkspaceCreateOnNode } from '../routes/workspaces/_helpers';
import { startComputeTrackingForNode } from '../routes/workspaces/workspace-create-helpers';
import { waitForNodeAgentReady } from './node-agent';
import {
  assertDirectWorkspaceProvisioningAuthority,
  cleanupFreshProvisioningNode,
  type FreshProvisioningNodeCleanupResult,
} from './provisioning-authority';
import { attachPrecreatedWorkspacePlacement } from './workspace-placement';
import { resolveWorkspaceAdmissionPolicy } from './workspace-resource-capacity';

export interface DirectWorkspaceCreationInput {
  placement: Parameters<typeof attachPrecreatedWorkspacePlacement>[1];
  linkedProject: Parameters<typeof scheduleWorkspaceCreateOnNode>[6];
  taskId: string;
  chatSessionId: string | null;
  mustProvisionNode: boolean;
  gitUserName: string | null;
  gitUserEmail: string | null;
}

export async function assertDirectCreationAuthority(
  env: Env,
  input: DirectWorkspaceCreationInput,
  attached: boolean
): Promise<void> {
  await assertDirectWorkspaceProvisioningAuthority(env, {
    workspaceId: input.placement.id,
    taskId: input.taskId,
    userId: input.placement.userId,
    projectId: input.placement.projectId,
    expectedNodeId: attached ? input.placement.nodeId : null,
    chatSessionId: input.chatSessionId,
  });
}

/** Replayable post-allocation continuation; false means readiness should be polled on a later alarm. */
export async function continueDirectWorkspaceCreation(
  env: Env,
  input: DirectWorkspaceCreationInput,
  allocationIncarnationId?: string
): Promise<boolean> {
  const { placement, linkedProject, taskId: chatTaskId, chatSessionId, mustProvisionNode } = input;
  const {
    id: workspaceId,
    nodeId: targetNodeId,
    userId,
    name: workspaceName,
    installationId: resolvedInstallationId,
    repository: resolvedRepository,
    branch,
    vmSize: workspaceVmSize,
    vmLocation: workspaceVmLocation,
    resourceRequirementsJson,
    capacityPlacementSnapshot,
    authorityNodeClass,
    resolvedReservation,
    createdAt: now,
  } = placement;
  const uniqueName = {
    displayName: placement.displayName,
    normalizedDisplayName: placement.normalizedDisplayName,
  };
  const admissionPolicy = resolveWorkspaceAdmissionPolicy(env);
  const assertDirectWorkspaceDispatchAuthority = () =>
    assertDirectCreationAuthority(env, input, true);

  const innerDb = drizzle(env.DATABASE, { schema });
  const markDirectWorkspaceProvisioningFailed = async (
    message: string,
    cleanup: FreshProvisioningNodeCleanupResult,
    terminatedIncarnation: string | null = null,
    terminatedAt: string | null = null
  ) => {
    const failedAt = new Date().toISOString();
    // Preserve authoritative absence before the unattached node identity is
    // lost. A skipped or failed cleanup cannot establish deletion proof.
    const proof = {
      'placeholder-deleted': 'workspace_never_started',
      'strict-deleted': 'node_runtime_terminated',
      skipped: null,
      failed: null,
    }[cleanup];
    const workspaceFailed = await env.DATABASE.prepare(
      `UPDATE workspaces
      SET status = 'error',
          error_message = ?,
          runtime_deletion_confirmed_at = ?,
          runtime_deletion_proof = ?,
          updated_at = ?
    WHERE id = ?
      AND user_id = ?
      AND project_id = ?
      AND node_id IS NULL
      AND chat_session_id IS ?
      AND status = 'creating'
      AND runtime_deletion_confirmed_at IS NULL
      AND (? IS NULL OR EXISTS (SELECT 1 FROM nodes n WHERE n.id=? AND n.user_id=?
        AND n.runtime_incarnation_id=? AND n.runtime_termination_confirmed_at=?
        AND n.status='deleted' AND n.runtime='vm' AND n.node_class='managed' AND n.node_role='workspace'))`
    )
      .bind(
        message,
        proof ? failedAt : null,
        proof,
        failedAt,
        workspaceId,
        userId,
        linkedProject.id,
        chatSessionId,
        terminatedIncarnation,
        targetNodeId,
        userId,
        terminatedIncarnation,
        terminatedAt
      )
      .run();
    if ((workspaceFailed.meta?.changes ?? 0) !== 1) return true;
    await env.DATABASE.prepare(
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
    const nodeRows = await innerDb
      .select({
        status: schema.nodes.status,
        errorMessage: schema.nodes.errorMessage,
        userId: schema.nodes.userId,
        runtimeIncarnationId: schema.nodes.runtimeIncarnationId,
        runtimeTerminationConfirmedAt: schema.nodes.runtimeTerminationConfirmedAt,
        runtime: schema.nodes.runtime,
        nodeClass: schema.nodes.nodeClass,
        nodeRole: schema.nodes.nodeRole,
      })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, targetNodeId))
      .limit(1);

    const provisionedNode = nodeRows[0];
    if (provisionedNode?.status === 'creating') return false;
    if (!provisionedNode || provisionedNode.status !== 'running') {
      const alreadyTerminated =
        provisionedNode?.status === 'deleted' &&
        provisionedNode.userId === userId &&
        provisionedNode.runtime === 'vm' &&
        provisionedNode.nodeClass === 'managed' &&
        provisionedNode.nodeRole === 'workspace' &&
        allocationIncarnationId !== undefined &&
        provisionedNode.runtimeIncarnationId === allocationIncarnationId &&
        provisionedNode.runtimeTerminationConfirmedAt !== null;
      const cleanup = alreadyTerminated
        ? 'strict-deleted'
        : await cleanupFreshProvisioningNode(env, {
            nodeId: targetNodeId,
            userId,
            nodeRole: 'workspace',
            reason: 'direct_workspace_node_not_running',
          });
      await markDirectWorkspaceProvisioningFailed(
        provisionedNode?.errorMessage || 'Node provisioning failed',
        cleanup,
        alreadyTerminated ? allocationIncarnationId : null,
        alreadyTerminated ? provisionedNode.runtimeTerminationConfirmedAt : null
      );
      return true;
    }

    const currentWorkspace = await innerDb
      .select()
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1);
    const current = currentWorkspace[0];
    const alreadyAttached = current?.nodeId === targetNodeId;
    if (
      alreadyAttached &&
      (current.userId !== userId ||
        current.projectId !== linkedProject.id ||
        current.chatSessionId !== chatSessionId ||
        !['creating', 'running', 'recovery'].includes(current.status) ||
        current.runtimeDeletionConfirmedAt !== null)
    )
      return true;
    if (alreadyAttached && current.status === 'creating')
      await assertDirectWorkspaceDispatchAuthority();
    const placementAttached =
      alreadyAttached ||
      (await attachPrecreatedWorkspacePlacement(
        env.DATABASE,
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
      ));
    if (!placementAttached) {
      const cleanup = await cleanupFreshProvisioningNode(env, {
        nodeId: targetNodeId,
        userId,
        nodeRole: 'workspace',
        reason: 'direct_workspace_final_admission_failed',
      });
      await markDirectWorkspaceProvisioningFailed(
        'Node lost capacity or placement authority before workspace creation',
        cleanup
      );
      return true;
    }

    // Provisioning has persisted native hardware and final admission has
    // attached the workspace. Meter now: readiness can outlive waitUntil,
    // while cloud-init independently brings the workspace online.
    await startComputeTrackingForNode(innerDb, {
      idempotencyKey: `direct-workspace:${workspaceId}`,
      propagateFailure: true,
      userId,
      workspaceId,
      nodeId: targetNodeId,
      vmSize: workspaceVmSize,
    });

    if (current && (current.dispatchedAt || ['running', 'recovery'].includes(current.status)))
      return true;
    try {
      await waitForNodeAgentReady(targetNodeId, env);
    } catch {
      return false;
    }
  }

  const current = await innerDb
    .select({ status: schema.workspaces.status, dispatchedAt: schema.workspaces.dispatchedAt })
    .from(schema.workspaces)
    .where(eq(schema.workspaces.id, workspaceId))
    .limit(1);
  if (
    current[0]?.status === 'running' ||
    current[0]?.status === 'recovery' ||
    current[0]?.dispatchedAt
  )
    return true;
  await scheduleWorkspaceCreateOnNode(
    env,
    workspaceId,
    targetNodeId,
    userId,
    resolvedRepository,
    branch,
    linkedProject,
    input.gitUserName,
    input.gitUserEmail,
    { beforeExternalMutation: assertDirectWorkspaceDispatchAuthority, durableRetry: true }
  );
  return true;
}
