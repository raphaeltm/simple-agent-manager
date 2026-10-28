import type { Env } from '../env';
import { type GuardedNodeAgentMutationOptions,nodeAgentRequest } from './node-agent';

export interface WorkspacePhysicalDeletionIdentity {
  workspaceId: string;
  nodeId: string;
  nodeRuntimeIncarnationId: string;
  userId: string;
  workspaceGeneration: string;
}

export async function deleteWorkspaceOnNode(
  nodeId: string,
  workspaceId: string,
  env: Env,
  userId: string,
  options: {
    identity: WorkspacePhysicalDeletionIdentity;
    requestTimeoutMs?: number;
  } & GuardedNodeAgentMutationOptions
): Promise<unknown> {
  const response = await nodeAgentRequest(nodeId, env, `/workspaces/${workspaceId}`, {
    method: 'DELETE',
    userId,
    workspaceId,
    body: JSON.stringify(options.identity),
    requestTimeoutMs: options.requestTimeoutMs,
    beforeExternalMutation: options.beforeExternalMutation,
    recoverContainerOnTimeout: false,
  });
  const proof = response as
    | (Partial<WorkspacePhysicalDeletionIdentity> & {
        physicalDeleted?: boolean;
        success?: boolean;
      })
    | null;
  if (
    !proof ||
    proof.success !== true ||
    proof.physicalDeleted !== true ||
    Object.entries(options.identity).some(
      ([key, value]) => proof[key as keyof WorkspacePhysicalDeletionIdentity] !== value
    )
  ) {
    throw new Error('Node did not confirm physical deletion of the exact workspace incarnation');
  }
  return response;
}
