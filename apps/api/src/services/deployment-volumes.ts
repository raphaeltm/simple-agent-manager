// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
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
  NAMED_VOLUME_BIND_DATA_DIR,
  resolveLinkedDeploymentNodeVolumeTarget,
  resolveNamedVolumeBindSource,
  resolveNamedVolumeMountRoot,
  resolveVolumeMountRoot,
} from '@simple-agent-manager/app-deployment';
