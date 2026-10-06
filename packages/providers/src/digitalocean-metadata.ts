import type { VMSize } from '@simple-agent-manager/shared';

import { DIGITALOCEAN_VOLUME_NAME_TAG_KEY, digitalOceanTagsToLabels } from './digitalocean-tags';
import type {
  LocationMeta,
  ProviderErrorCategory,
  ProviderLogger,
  SizeConfig,
  VMStatus,
  VolumeCapabilities,
  VolumeInstance,
} from './types';
import {
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import type { DigitalOceanNetworkV4, DigitalOceanVolumePayload } from './validation-digitalocean';

export const DIGITALOCEAN_API_URL = 'https://api.digitalocean.com/v2';
export const DIGITALOCEAN_LIST_PER_PAGE = 200;

export const DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS = 20_000;
export const DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_DIGITALOCEAN_ACTION_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_DIGITALOCEAN_MAX_LIST_PAGES = 20;

export const DIGITALOCEAN_LOCATIONS = [
  'fra1',
  'ams3',
  'lon1',
  'nyc1',
  'nyc3',
  'sfo3',
  'tor1',
  'sgp1',
  'blr1',
  'syd1',
] as const;

export const DIGITALOCEAN_LOCATION_META: Record<string, LocationMeta> = {
  fra1: { name: 'Frankfurt', country: 'DE' },
  ams3: { name: 'Amsterdam', country: 'NL' },
  lon1: { name: 'London', country: 'GB' },
  nyc1: { name: 'New York 1', country: 'US' },
  nyc3: { name: 'New York 3', country: 'US' },
  sfo3: { name: 'San Francisco', country: 'US' },
  tor1: { name: 'Toronto', country: 'CA' },
  sgp1: { name: 'Singapore', country: 'SG' },
  blr1: { name: 'Bangalore', country: 'IN' },
  syd1: { name: 'Sydney', country: 'AU' },
};

export const DIGITALOCEAN_SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: { type: 's-2vcpu-4gb', price: '~$24/mo', vcpu: 2, ramGb: 4, storageGb: 80 },
  medium: { type: 's-4vcpu-8gb', price: '~$48/mo', vcpu: 4, ramGb: 8, storageGb: 160 },
  large: { type: 's-8vcpu-16gb', price: '~$96/mo', vcpu: 8, ramGb: 16, storageGb: 320 },
};

export interface DigitalOceanProviderRuntimeOptions {
  region?: string;
  image?: string;
  requestTimeoutMs?: number;
  ipPollTimeoutMs?: number;
  ipPollIntervalMs?: number;
  actionPollTimeoutMs?: number;
  actionPollIntervalMs?: number;
  maxListPages?: number;
  logger?: ProviderLogger;
}

export function classifyDigitalOceanError(
  statusCode: number | undefined,
  message: string
): ProviderErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (typeof statusCode === 'number' && statusCode >= 500) return 'transient_capacity';
  if (/not available|no capacity|out of stock|sold out|no available|unavailable/i.test(message)) {
    return 'transient_capacity';
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return 'invalid_config';
  return 'unknown';
}

export function mapDigitalOceanStatus(status: string): VMStatus {
  switch (status) {
    case 'new':
      return 'initializing';
    case 'active':
      return 'running';
    case 'off':
    case 'archive':
      return 'off';
    default:
      return 'initializing';
  }
}

export function extractPublicIp(networks: DigitalOceanNetworkV4[]): string {
  const publicNet = networks.find((net) => net.type === 'public' && net.ip_address);
  return publicNet?.ip_address ?? '';
}

export function sanitizeDropletName(name: string): string {
  const host = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    .replace(/^-+|-+$/g, '');
  return host || 'sam-node';
}

export function resolveDigitalOceanImage(image: string): string | number {
  const trimmed = image.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed;
}

export const DIGITALOCEAN_VOLUME_MIN_SIZE_GB = 1;
export const DIGITALOCEAN_VOLUME_MAX_SIZE_GB = 16_384;
const DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH = 64;

export const DIGITALOCEAN_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: DIGITALOCEAN_VOLUME_MIN_SIZE_GB,
  maxSizeGb: DIGITALOCEAN_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'DigitalOcean Block Storage is available in all current DO regions; create the volume in the same region as its droplet.',
    'DO volume names are lowercased/sanitized/truncated to 64 chars; SAM round-trips the exact volume name via a sam-name tag. The provider creates raw block devices; SAM node-side code formats ext4 and mounts with nofail.',
    'linuxDevice is the deterministic DO by-id path /dev/disk/by-id/scsi-0DO_Volume_<name>.',
  ],
};

export type DigitalOceanErrorMapper = (err: unknown) => unknown;

export interface DigitalOceanVolumeClientOptions {
  requestTimeoutMs: number;
  actionPollTimeoutMs: number;
  actionPollIntervalMs: number;
  maxListPages: number;
  logger?: ProviderLogger;
}

export function sanitizeDigitalOceanVolumeName(name: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH)
    .replace(/-+$/g, '');
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `v${sanitized}`.slice(0, DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH).replace(/-+$/g, '');
  }
  return sanitized || 'sam-volume';
}

export function toDigitalOceanDropletId(serverId: string): number {
  const dropletId = Number(serverId);
  if (!Number.isInteger(dropletId) || dropletId <= 0) {
    throw new ProviderError(
      'digitalocean',
      undefined,
      `Invalid DigitalOcean droplet id: "${serverId}"`,
      { category: 'invalid_config' }
    );
  }
  return dropletId;
}

export function validateDigitalOceanVolumeSize(sizeGb: number): void {
  if (!Number.isInteger(sizeGb) || sizeGb < DIGITALOCEAN_VOLUME_MIN_SIZE_GB) {
    throw new ProviderError(
      'digitalocean',
      undefined,
      `DigitalOcean volume size must be an integer >= ${DIGITALOCEAN_VOLUME_MIN_SIZE_GB}GB`,
      { category: 'invalid_config' }
    );
  }
  if (sizeGb > DIGITALOCEAN_VOLUME_MAX_SIZE_GB) {
    throw new ProviderError(
      'digitalocean',
      undefined,
      `DigitalOcean volume size must be <= ${DIGITALOCEAN_VOLUME_MAX_SIZE_GB}GB`,
      { category: 'invalid_config' }
    );
  }
}

export function mapDigitalOceanVolume(volume: DigitalOceanVolumePayload): VolumeInstance {
  const decoded = digitalOceanTagsToLabels(volume.tags);
  const { [DIGITALOCEAN_VOLUME_NAME_TAG_KEY]: encodedName, ...labels } = decoded;
  const attachedServerId =
    volume.droplet_ids.length > 0 ? String(volume.droplet_ids[0]) : undefined;

  return {
    id: volume.id,
    name: encodedName ?? volume.name,
    sizeGb: volume.size_gigabytes,
    location: volume.region_slug,
    status: attachedServerId ? 'attached' : 'available',
    ...(attachedServerId ? { attachedServerId } : {}),
    ...(volume.name ? { linuxDevice: `/dev/disk/by-id/scsi-0DO_Volume_${volume.name}` } : {}),
    createdAt: volume.created_at,
    labels,
  };
}
