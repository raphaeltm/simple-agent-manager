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

/**
 * A pool with no machines in it (none picked, or only on switched-off accounts). Nothing joins
 * a pool on its own, so this is an ordinary state for a new account: say so plainly and name
 * both ways forward instead of describing resource requirements that are not the problem.
 */
export function emptyCapacityPoolMessage(scope: TaskStartCapacityPoolSelection['scope']): string {
  const pool =
    scope === 'project'
      ? "This project's compute pool"
      : scope === 'user'
        ? 'Your compute pool'
        : 'The shared compute pool';
  const fix =
    scope === 'installation'
      ? 'Ask an admin to add machines to it'
      : 'Add machines to it in its infrastructure settings';
  return `${pool} has no machines, so work that needs a VM cannot start. ${fix}, or run this as an Instant session.`;
}

export function noEligibleCapacityCandidateMessage(
  placement: TaskStartPlacement,
  selection: TaskStartCapacityPoolSelection
): string {
  if (selection.effectiveState === 'configured-empty') {
    return emptyCapacityPoolMessage(selection.scope);
  }
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
