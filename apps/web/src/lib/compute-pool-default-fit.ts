import {
  DEFAULT_NODE_HOST_MEMORY_RESERVE_MB,
  PLATFORM_RESOURCE_DEFAULTS,
} from '@simple-agent-manager/shared';

import type { MachineGroup } from './compute-pool-machines';

/**
 * A plain warning when no allowed machine in the pool can hold a workspace that asks for the
 * platform defaults: placement subtracts the host memory reserve from each machine first, so a
 * 4 GB machine (Google Cloud e2-medium) can never place the 4 GB default.
 *
 * Uses the defaults: an installation that overrides the host reserve or the default
 * requirements can fit differently. Returns null when the pool allows nothing (that has its own
 * warning) or when any allowed machine's size is unknown (we cannot tell).
 */
export function defaultWorkspaceFitWarning(groups: MachineGroup[]): string | null {
  const allowed = groups.flatMap((group) =>
    group.rows.filter((row) => row.cells.some((cell) => cell.allowed))
  );
  if (allowed.length === 0) return null;
  const neededMemoryMb = PLATFORM_RESOURCE_DEFAULTS.minMemoryGb * 1024;
  const fits = (vcpu: number | null, ramGb: number | null) =>
    vcpu === null ||
    ramGb === null ||
    (vcpu >= PLATFORM_RESOURCE_DEFAULTS.minVcpu &&
      ramGb * 1024 - DEFAULT_NODE_HOST_MEMORY_RESERVE_MB >= neededMemoryMb);
  if (allowed.some((row) => fits(row.vcpu, row.ramGb))) return null;
  const totalGb = (neededMemoryMb + DEFAULT_NODE_HOST_MEMORY_RESERVE_MB) / 1024;
  return (
    `No allowed machine can run a default workspace. It needs ${PLATFORM_RESOURCE_DEFAULTS.minVcpu} vCPU ` +
    `and ${PLATFORM_RESOURCE_DEFAULTS.minMemoryGb} GB of memory, and each machine keeps ` +
    `${DEFAULT_NODE_HOST_MEMORY_RESERVE_MB / 1024} GB for itself, so allow a machine with at least ` +
    `${totalGb} GB (for example 8 GB) or chats and tasks will fail to start.`
  );
}
