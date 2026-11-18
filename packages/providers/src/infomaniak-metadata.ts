/**
 * Infomaniak (OpenStack) constants, static catalog and response parsers, kept apart from the
 * provider class in infomaniak.ts.
 */
import { DEFAULT_INFOMANIAK_BOOT_VOLUME_GB, type VMSize } from '@simple-agent-manager/shared';

import {
  type LocationMeta,
  ProviderError,
  type ProviderErrorCategory,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
  type SizeConfig,
  type VMStatus,
  type VolumeCapabilities,
  type VolumeStatus,
} from './types';

export const DEFAULT_INFOMANIAK_AUTH_URL = 'https://api.pub1.infomaniak.cloud/identity/v3';
export const DEFAULT_INFOMANIAK_REGION = 'dc4-a';
export const DEFAULT_INFOMANIAK_ENDPOINT_INTERFACE = 'public';
export const DEFAULT_INFOMANIAK_NETWORK_NAME = 'ext-net1';
export const DEFAULT_INFOMANIAK_IMAGE_NAME = 'Ubuntu 24.04 noble';
export const DEFAULT_INFOMANIAK_VOLUME_TYPE = 'CEPH_1_perf1';
export const DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS = 45_000;
export const DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS = 3_000;
export const INFOMANIAK_VOLUME_MIN_SIZE_GB = 1;
export const INFOMANIAK_VOLUME_MAX_SIZE_GB = 10_240;
export const INFOMANIAK_LOCATIONS = ['dc3-a', 'dc4-a'] as const;

export const INFOMANIAK_LOCATION_METADATA: Readonly<Record<string, LocationMeta>> = {
  'dc3-a': { name: 'Geneva (DC3)', country: 'CH' },
  'dc4-a': { name: 'Geneva (DC4)', country: 'CH' },
};
export const INFOMANIAK_FLAVORS: Readonly<Record<VMSize, string>> = {
  small: 'a2-ram4-disk20-perf1',
  medium: 'a4-ram8-disk20-perf1',
  large: 'a8-ram16-disk20-perf1',
};
/**
 * Static catalog. `storageGb` is the default boot volume, not the flavor's 20 GB local disk: SAM
 * boots Infomaniak VMs from a Cinder volume (infomaniak-boot-volume.ts).
 */
export const INFOMANIAK_SIZE_CONFIGS: Readonly<Record<VMSize, SizeConfig>> = {
  small: {
    type: INFOMANIAK_FLAVORS.small,
    price: 'usage-based',
    vcpu: 2,
    ramGb: 4,
    storageGb: DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  },
  medium: {
    type: INFOMANIAK_FLAVORS.medium,
    price: 'usage-based',
    vcpu: 4,
    ramGb: 8,
    storageGb: DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  },
  large: {
    type: INFOMANIAK_FLAVORS.large,
    price: 'usage-based',
    vcpu: 8,
    ramGb: 16,
    storageGb: DEFAULT_INFOMANIAK_BOOT_VOLUME_GB,
  },
};

export function mergeInfomaniakLegacySizes(
  flavors: Partial<Record<VMSize, string>> | undefined,
  bootVolumeSizeGb: number
): Readonly<Record<VMSize, SizeConfig>> {
  const size = (vmSize: VMSize): SizeConfig => ({
    ...INFOMANIAK_SIZE_CONFIGS[vmSize],
    ...(flavors?.[vmSize] ? { type: flavors[vmSize] } : {}),
    storageGb: bootVolumeSizeGb,
  });
  return { small: size('small'), medium: size('medium'), large: size('large') };
}

export const INFOMANIAK_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: 1,
  maxSizeGb: 10_240,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'Volumes and servers must use the same Infomaniak region.',
    'Resize is grow-only and requires the volume to be detached first.',
    'Discover devices under /dev/disk/by-id using the Cinder volume ID; requested device names are unsupported.',
  ],
};

export function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value as Record<string, unknown>;
}
export function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
export function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value)
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
export function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
export function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return asNumber(value, path);
}
export function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  const number = optionalNumber(value, path);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number <= 0)
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return number;
}
export function optionalNonNegativeInteger(value: unknown, path: string): number | undefined {
  const number = optionalNumber(value, path);
  if (number === undefined) return undefined;
  if (!Number.isInteger(number) || number < 0)
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return number;
}
export function infomaniakMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}
export function infomaniakBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}
export function classifyInfomaniakError(
  status: number | undefined,
  message: string
): ProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 409 && /quota/i.test(message)) return 'quota_exceeded';
  if (status === 409 || status === 503 || /capacity|no valid host/i.test(message))
    return 'transient_capacity';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 404 || status === 422) return 'invalid_config';
  return 'unknown';
}
export function mapInfomaniakStatus(status: string): VMStatus {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'running';
    case 'SHUTOFF':
    case 'STOPPED':
    case 'PAUSED':
    case 'SUSPENDED':
      return 'off';
    case 'REBOOT':
    case 'HARD_REBOOT':
      return 'starting';
    default:
      return 'initializing';
  }
}
export function infomaniakVolumeStatus(status: string): VolumeStatus {
  switch (status.toLowerCase()) {
    case 'creating':
      return 'creating';
    case 'available':
      return 'available';
    case 'attaching':
      return 'attaching';
    case 'in-use':
      return 'attached';
    case 'detaching':
      return 'detaching';
    case 'extending':
      return 'resizing';
    case 'deleting':
      return 'deleting';
    default:
      return 'unknown';
  }
}
