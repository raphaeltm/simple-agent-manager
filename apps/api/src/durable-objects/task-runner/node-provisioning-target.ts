import type { TaskStartCapacityCandidate } from '../../services/placement-resolver';
import { capacityPlacementSnapshotForCandidate } from '../../services/placement-resolver';
import type { TaskRunnerState } from './types';

export function applyCapacityCandidateProvisioningTarget(
  state: TaskRunnerState,
  candidate: TaskStartCapacityCandidate
): void {
  state.config.cloudProvider = candidate.provider;
  state.config.vmLocation = candidate.location;
  state.config.providerInstanceType = candidate.providerInstanceType;
  state.config.providerInstanceBootDiskSizeGb = candidate.providerInstanceDiskGb ?? null;
  state.config.providerInstanceImage = null;
  state.config.providerInstanceArchitecture = null;
  state.config.vmSize = candidate.machineSize ?? state.config.vmSize;
  state.config.credentialAttributionProjectId =
    candidate.credentialAttributionSource === 'project'
      ? (candidate.capacityPoolProjectId ?? state.projectId)
      : null;
  state.config.credentialAttributionSource = candidate.credentialAttributionSource;
  const snapshot = state.config.capacityPoolSelection
    ? capacityPlacementSnapshotForCandidate(state.config.capacityPoolSelection, candidate)
    : null;
  state.stepResults.capacityPlacementSnapshot = snapshot
    ? {
        ...snapshot,
        providerInstanceBootDiskSizeGb: candidate.providerInstanceDiskGb ?? null,
      }
    : null;
}
