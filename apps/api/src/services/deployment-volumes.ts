/** Re-export: this module moved to `src/app-deployment/deployment-volumes.ts`. */
export type {
  CreateVolumeOptions,
  LinkedDeploymentNodeVolumeTarget,
  VolumeMountDescriptor,
} from '../app-deployment';
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
} from '../app-deployment';
