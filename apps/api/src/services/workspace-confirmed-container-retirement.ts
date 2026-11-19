import type { Env } from '../env';
import { stopNodeResources } from './node-resource-lifecycle';
import type { WorkspaceDeletionIdentity } from './workspace-deletion';

/** Finish the SAME proof-bearing deletion operation, retaining its exact node fence. */
export async function retireConfirmedContainerWorkspaceNode(
  env: Env,
  expected: WorkspaceDeletionIdentity
): Promise<void> {
  if (expected.nodeRuntime !== 'cf-container') return;
  if (
    !expected.nodeId ||
    !expected.nodeRuntimeIncarnationId ||
    expected.nodeUserId !== expected.userId
  ) {
    throw new Error('Confirmed container retirement requires exact owner and incarnation');
  }
  await stopNodeResources(expected.nodeId, expected.userId, env, {
    expectedRuntime: {
      userId: expected.userId,
      runtime: expected.nodeRuntime,
      providerInstanceId: expected.nodeProviderInstanceId,
      runtimeIncarnationId: expected.nodeRuntimeIncarnationId,
    },
  });
}
