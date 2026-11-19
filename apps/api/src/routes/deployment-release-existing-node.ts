import type { DeploymentNodeAdmissionRejection } from '../services/deployment-node-admission-result';
import {
  type DeploymentPlacement,
  findDeploymentNodeWithCapacity,
  linkEnvironmentToNode,
} from '../services/deployment-provisioning';
import type { PlaceReleaseOnDeploymentNodeParams } from './deployment-release-placement';

export async function reserveExistingNodeForRelease(params: {
  release: PlaceReleaseOnDeploymentNodeParams;
  nodeId: string;
  expectedReservationJson: string | null;
  beforeExternalMutation: () => Promise<void>;
}): Promise<{
  admitted: boolean;
  placement: DeploymentPlacement | null;
  reason?: DeploymentNodeAdmissionRejection;
}> {
  if (!params.release.placement) return { admitted: true, placement: null };
  await params.beforeExternalMutation();
  const nodeMode = params.release.requiresVolumes ? 'exclusive' : 'shared';
  let reason: DeploymentNodeAdmissionRejection = 'unavailable';
  const currentNode = await findDeploymentNodeWithCapacity(
    params.release.env,
    params.release.userId,
    params.release.placement,
    params.release.requiresVolumes,
    {
      nodeId: params.nodeId,
      excludeEnvironmentId: params.release.envId,
      nodeMode,
      onRejection: (rejection) => {
        reason = rejection;
      },
    }
  );
  if (currentNode?.nodeId !== params.nodeId) return { admitted: false, placement: null, reason };
  const linked = await linkEnvironmentToNode({
    env: params.release.env,
    db: params.release.db,
    envId: params.release.envId,
    nodeId: params.nodeId,
    placement: currentNode.placement,
    userId: params.release.userId,
    expectedNodeStatus: 'running',
    nodeMode,
    expectedReservationJson: params.expectedReservationJson,
    releaseId: params.release.releaseId,
  });
  return {
    admitted: linked,
    placement: linked ? currentNode.placement : null,
    reason: 'authority-changed',
  };
}
