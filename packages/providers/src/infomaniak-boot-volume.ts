/**
 * Boot volumes for SAM-created Infomaniak VMs.
 *
 * Infomaniak flavors carry a small local root disk (20 GB on `a2-ram4-disk20-perf1` and its
 * siblings), which devcontainer builds fill (#2842). SAM therefore boots every new VM from a Cinder
 * volume it sizes itself, through Nova's `block_device_mapping_v2`, and Nova deletes that volume
 * with the server (`delete_on_termination`).
 *
 * One size decides the catalog (the offering's `diskGb`, which becomes the pool candidate's disk),
 * the volume `InfomaniakProvider.createVM` requests, and the observed disk read back from the
 * server, so placement reserves against the disk the node actually has. The size is the admin
 * setting `infomaniak.bootVolumeGb`, resolved by the API and passed to the provider.
 *
 * Nova compatibility: SAM sends no microversion header, so requests use the base 2.1 API, which
 * accepts every field below. `volume_type` inside a mapping needs microversion 2.67 and is
 * deliberately not sent: the volume gets the project's default Cinder type.
 */

import {
  DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  INFOMANIAK_BOOT_VOLUME_MAX_GB,
  INFOMANIAK_BOOT_VOLUME_MIN_GB,
} from '@simple-agent-manager/shared';

import type { NativeVMConfigSource } from './native-vm-config';
import type { NativeVMConfig, VMHardwareResources } from './types';

export {
  DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  INFOMANIAK_BOOT_VOLUME_MAX_GB,
  INFOMANIAK_BOOT_VOLUME_MIN_GB,
};

/**
 * Server metadata key recording the boot volume size SAM requested. A volume-booted server's
 * `flavor.disk` still names the flavor's unused local disk, so this is the only cheap source of the
 * root disk size on get/list. The same key is used by the reporter's fork, so nodes it created are
 * read correctly too.
 */
export const INFOMANIAK_ROOT_DISK_METADATA_KEY = 'sam-root-disk-gb';

export const INFOMANIAK_BOOT_VOLUME_LIMITS = Object.freeze({
  min: INFOMANIAK_BOOT_VOLUME_MIN_GB,
  max: INFOMANIAK_BOOT_VOLUME_MAX_GB,
});

/**
 * Normalize a configured boot volume size. Never throws: every provider build goes through this,
 * including teardown of existing nodes, so a bad configured value must not block deletion. An
 * out-of-range or non-integer value falls back to the default, as `normalizeGcpBootDiskPolicy`
 * does for GCP. The admin setting's own validator already keeps stored values in range.
 * Explicit per-request `bootDiskSizeGb` values are validated (and rejected) in `createVM`.
 */
export function resolveInfomaniakBootVolumeSizeGb(value: number | undefined): number {
  return isValidBootVolumeGb(value) ? value : DEFAULT_INFOMANIAK_BOOT_VOLUME_GB;
}

function isValidBootVolumeGb(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= INFOMANIAK_BOOT_VOLUME_MIN_GB &&
    value <= INFOMANIAK_BOOT_VOLUME_MAX_GB
  );
}

/**
 * Boot volume for a request that names no `bootDiskSizeGb`. A pool plan is a native request
 * carrying the candidate's disk as `resources.diskGb`, which is what placement reserved against, so
 * the volume is never smaller than that. It is never smaller than the configured size either:
 * candidates published before #2842 still carry the flavor's 20 GB, the exact size that filled up,
 * until the next catalog refresh re-publishes them. The node's observed disk is read back from the
 * server (`sam-root-disk-gb`), so admission sees the larger size. Any other request gets the
 * configured size.
 */
export function infomaniakDefaultBootVolumeGb(
  resolved: Pick<NativeVMConfig, 'resources'>,
  source: NativeVMConfigSource,
  configuredSizeGb: number
): number {
  const plannedDiskGb = resolved.resources?.diskGb;
  if (
    source === 'native' &&
    typeof plannedDiskGb === 'number' &&
    Number.isInteger(plannedDiskGb) &&
    plannedDiskGb > configuredSizeGb
  ) {
    return plannedDiskGb;
  }
  return configuredSizeGb;
}

/** The single boot device: a new volume built from the image, deleted with the server. */
export function infomaniakBootVolumeMapping(imageId: string, sizeGb: number) {
  return [
    {
      boot_index: 0,
      uuid: imageId,
      source_type: 'image',
      destination_type: 'volume',
      volume_size: sizeGb,
      delete_on_termination: true,
    },
  ];
}

/** Server metadata for a new VM: SAM's labels plus the root disk record, which always wins. */
export function infomaniakServerMetadata(
  labels: Record<string, string>,
  bootVolumeGb: number
): Record<string, string> {
  return { ...labels, [INFOMANIAK_ROOT_DISK_METADATA_KEY]: String(bootVolumeGb) };
}

export type InfomaniakObservedResources =
  | { resources: VMHardwareResources; unknownReason?: undefined }
  | { resources: null; unknownReason: string };

/**
 * Observed resources for a Nova server. Root disk depends on how the server booted:
 *
 * - From an image (`image` is an object with an id): the flavor's local disk, as before. Nodes
 *   created before #2842 are all in this state and keep their observed disk.
 * - From a volume (`image` is `""`): the size SAM recorded in `sam-root-disk-gb`. If that record is
 *   missing or malformed the disk is unknown, never the flavor's unused local disk.
 * - Anything else (no `image` field): unknown.
 *
 * Never throws, so one odd server cannot fail a list.
 */
export function infomaniakObservedResources(input: {
  image: unknown;
  metadata: Record<string, string>;
  vcpus: number | undefined;
  ramMb: number | undefined;
  flavorDiskGb: number | undefined;
}): InfomaniakObservedResources {
  if (input.vcpus === undefined || input.ramMb === undefined)
    return { resources: null, unknownReason: 'Infomaniak server flavor omitted resource fields' };
  const base = { vcpuCount: input.vcpus, memoryMb: input.ramMb };
  if (isImageBooted(input.image)) {
    return input.flavorDiskGb === undefined
      ? { resources: null, unknownReason: 'Infomaniak server flavor omitted resource fields' }
      : { resources: { ...base, diskGb: input.flavorDiskGb } };
  }
  if (input.image !== '')
    return { resources: null, unknownReason: 'Infomaniak server response omitted its boot source' };
  const recorded = input.metadata[INFOMANIAK_ROOT_DISK_METADATA_KEY];
  // Bounded like a request: the record is server metadata the project owner can edit.
  const diskGb = recorded !== undefined && /^[1-9]\d*$/.test(recorded) ? Number(recorded) : null;
  if (!isValidBootVolumeGb(diskGb))
    return {
      resources: null,
      unknownReason: `Infomaniak volume-booted server has no valid ${INFOMANIAK_ROOT_DISK_METADATA_KEY} record`,
    };
  return { resources: { ...base, diskGb } };
}

function isImageBooted(image: unknown): boolean {
  return (
    typeof image === 'object' &&
    image !== null &&
    !Array.isArray(image) &&
    typeof (image as { id?: unknown }).id === 'string' &&
    (image as { id: string }).id.length > 0
  );
}

/**
 * Re-size catalog offerings to the boot volume: the static catalog is written for the default size,
 * and an admin can change it at runtime.
 */
export function applyInfomaniakBootVolumeSize<
  T extends {
    diskGb?: number | null;
    storageGb?: number | null;
    displayName?: string;
    name?: string;
  },
>(offerings: readonly T[], sizeGb: number): T[] {
  const relabel = (label: string | undefined) =>
    label?.replace(/· \d+ GB disk$/, `· ${sizeGb} GB disk`);
  return offerings.map((offering) => ({
    ...offering,
    diskGb: sizeGb,
    storageGb: sizeGb,
    ...(offering.displayName !== undefined ? { displayName: relabel(offering.displayName) } : {}),
    ...(offering.name !== undefined ? { name: relabel(offering.name) } : {}),
  }));
}
