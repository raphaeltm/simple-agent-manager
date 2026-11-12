// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported so existing importers keep working. A vi.mock of this path does not reach
// imports made inside the package (see packages/app-deployment/AGENTS.md).
export type {
  CreateVolumeOptions,
  LinkedDeploymentNodeVolumeTarget,
  VolumeMountDescriptor,
} from '@simple-agent-manager/app-deployment';
export {
  attachEnvironmentVolumes,
  attachEnvironmentVolumesToLinkedNode,
  buildVolumeMountDescriptors,
  createEnvironmentVolume,
  createMissingDeclaredVolumes,
  createMissingManifestVolumes,
  deleteEnvironmentVolume,
  detachEnvironmentVolumes,
  detachEnvironmentVolumesFromLinkedNode,
  listEnvironmentVolumes,
  markDeploymentReleaseVolumeAttachFailed,
  resolveLinkedDeploymentNodeVolumeTarget,
  resolveNamedVolumeBindSource,
  resolveNamedVolumeMountRoot,
  resolveVolumeMountRoot,
} from '@simple-agent-manager/app-deployment';
