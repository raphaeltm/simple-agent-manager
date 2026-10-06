import type {
  PlacementResolutionErrorCode,
  TaskStartCapacityPoolSelection,
  TaskStartPlacement,
} from './placement-resolver-types';

export class PlacementResolutionError extends Error {
  readonly code: PlacementResolutionErrorCode;
  readonly validValues: readonly string[];

  constructor(code: PlacementResolutionErrorCode, message: string, validValues: readonly string[]) {
    super(message);
    this.name = 'PlacementResolutionError';
    this.code = code;
    this.validValues = validValues;
  }
}

export function noEligibleCapacityCandidateMessage(
  placement: TaskStartPlacement,
  selection: TaskStartCapacityPoolSelection
): string {
  const requirements = [
    `${Math.ceil(placement.resolvedReservation.cpuMillis / 1000)} vCPU`,
    `${placement.resolvedReservation.memoryMb} MB memory`,
    placement.resolvedReservation.diskMb > 0
      ? `${Math.ceil(placement.resolvedReservation.diskMb / 1024)} GB disk`
      : null,
  ].filter(Boolean);
  const provider = placement.provider ? ` provider ${placement.provider}` : '';
  const location = placement.explicitVmLocation ? ` location ${placement.vmLocation}` : '';
  return (
    `No eligible compute-pool offering is available in the ${selection.scope} default pool` +
    `${provider}${location} for this task's requirements (${requirements.join(', ')}). ` +
    'Reconcile the pool or add an active provider-native offering that satisfies the request.'
  );
}
