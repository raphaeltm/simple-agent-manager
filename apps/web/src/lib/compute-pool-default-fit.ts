import type { SafeCapacityPoolPlacementSettingsSummary } from '@simple-agent-manager/shared';

import type { MachineGroup } from './compute-pool-machines';
import { formatOfferingNumber } from './compute-pool-offerings';

/** What a default workspace asks for on this installation, as the pool response reports it. */
type DefaultFitSettings = Pick<SafeCapacityPoolPlacementSettingsSummary, 'resourceDefaults'> & {
  hostMemoryReserveMb?: number;
};

/**
 * A plain warning when no allowed machine in the pool can hold a workspace that asks for this
 * installation's default requirements. Placement subtracts the host memory reserve from each
 * machine first, so a 4 GB machine can never place a 4 GB default workspace.
 *
 * Reads the installation's resolved settings from the pool response
 * (`resolveSafeCapacityPoolPlacementSettingsSummary()`): its default requirements
 * (`capacityPools.platformDefaults.v1` or `CAPACITY_POOL_PLATFORM_DEFAULTS_JSON`) and its host
 * reserve. Returns null when those are unknown (an older server), when the pool allows nothing
 * (that has its own warning), or when any allowed machine's size is unknown (we cannot tell).
 */
export function defaultWorkspaceFitWarning(
  groups: MachineGroup[],
  settings: DefaultFitSettings | null | undefined
): string | null {
  const defaults = settings?.resourceDefaults.platformDefaults;
  const reserveMb = settings?.hostMemoryReserveMb;
  if (!defaults || reserveMb === undefined) return null;
  const allowed = groups.flatMap((group) => group.rows.filter((row) => row.allowed));
  if (allowed.length === 0) return null;
  const neededMemoryMb = defaults.minMemoryGb * 1024;
  // A machine of unknown size counts as a fit: say nothing rather than warn about a guess.
  // Disk mirrors placement (`capacityCandidateSatisfiesReservation`): checked only when known,
  // with no host reserve.
  const fits = allowed.some(
    ({ vcpu, ramGb, diskGb }) =>
      vcpu === null ||
      ramGb === null ||
      (vcpu >= defaults.minVcpu &&
        ramGb * 1024 - reserveMb >= neededMemoryMb &&
        (diskGb === null || diskGb >= defaults.minDiskGb))
  );
  if (fits) return null;
  const totalGb = (neededMemoryMb + reserveMb) / 1024;
  return (
    `No allowed machine can run a default workspace. It needs ` +
    `${formatOfferingNumber(defaults.minVcpu, '')} vCPU, ` +
    `${formatOfferingNumber(defaults.minMemoryGb, 'GB')} of memory and ` +
    `${formatOfferingNumber(defaults.minDiskGb, 'GB')} of disk, and each machine keeps ` +
    `${formatOfferingNumber(reserveMb / 1024, 'GB')} of memory for itself. Allow a machine with ` +
    `at least ${formatOfferingNumber(defaults.minVcpu, '')} vCPU, ` +
    `${formatOfferingNumber(totalGb, 'GB')} of memory and ` +
    `${formatOfferingNumber(defaults.minDiskGb, 'GB')} of disk, or workspaces this pool starts ` +
    `at the default size will fail to start.`
  );
}
