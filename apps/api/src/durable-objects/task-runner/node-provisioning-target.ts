import type { TaskStartCapacityCandidate } from '../../services/placement-resolver';
import { capacityPlacementSnapshotForCandidate } from '../../services/placement-resolver';
import type { TaskRunnerState } from './types';

export function applyCapacityCandidateProvisioningTarget(
  state: TaskRunnerState,
  candidate: TaskStartCapacityCandidate
): void {
  const snapshot = state.config.capacityPoolSelection
    ? capacityPlacementSnapshotForCandidate(state.config.capacityPoolSelection, candidate)
    : null;
  const nativePlan = snapshot ?? candidate;
  state.config.cloudProvider = candidate.provider;
  state.config.vmLocation = candidate.location;
  state.config.providerInstanceType = candidate.providerInstanceType;
  // Local disk capacity and an explicit boot-disk override are separate fields.
  // Preserve the selected native plan so the provider-bound authority check sees
  // the same offering that the resolver authorized, including null overrides.
  state.config.providerInstanceBootDiskSizeGb = nativePlan.providerInstanceBootDiskSizeGb ?? null;
  state.config.providerInstanceImage = nativePlan.providerInstanceImage ?? null;
  const architecture = nativePlan.providerInstanceArchitecture;
  state.config.providerInstanceArchitecture =
    architecture === 'x86_64' || architecture === 'arm64' ? architecture : null;
  state.config.vmSize = candidate.machineSize ?? state.config.vmSize;
  state.config.credentialAttributionProjectId =
    candidate.credentialAttributionSource === 'project'
      ? (candidate.capacityPoolProjectId ?? state.projectId)
      : null;
  state.config.credentialAttributionSource = candidate.credentialAttributionSource;
  state.stepResults.capacityPlacementSnapshot = snapshot;
}
