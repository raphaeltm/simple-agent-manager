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
  state.config.vmSize = candidate.machineSize ?? state.config.vmSize;
  state.config.credentialAttributionProjectId =
    candidate.credentialAttributionSource === 'project'
      ? (candidate.capacityPoolProjectId ?? state.projectId)
      : null;
  state.config.credentialAttributionSource = candidate.credentialAttributionSource;
  state.stepResults.capacityPlacementSnapshot = state.config.capacityPoolSelection
    ? capacityPlacementSnapshotForCandidate(state.config.capacityPoolSelection, candidate)
    : null;
}
