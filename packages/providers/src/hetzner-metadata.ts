import type { VMSize } from '@simple-agent-manager/shared';

import type {
  LocationMeta,
  ProviderErrorCategory,
  ProviderLogger,
  SizeConfig,
  VMInstance,
  VMStatus,
  VolumeCapabilities,
  VolumeInstance,
  VolumeStatus,
} from './types';
import {
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import type { HetznerServerPayload, HetznerVolumePayload } from './validation';

export const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

export const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'] as const;

export const HETZNER_LOCATION_META: Record<string, LocationMeta> = {
  fsn1: { name: 'Falkenstein', country: 'DE' },
  nbg1: { name: 'Nuremberg', country: 'DE' },
  hel1: { name: 'Helsinki', country: 'FI' },
  ash: { name: 'Ashburn', country: 'US' },
  hil: { name: 'Hillsboro', country: 'US' },
};

export const DEFAULT_PLACEMENT_RETRY_DELAY_MS = 3_000;
export const DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS = 15_000;
export const DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS = 120_000;
export const DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS = 10;
export const DEFAULT_CAPACITY_RETRY_BUDGET_MS = 300_000;
export const HETZNER_VOLUME_MIN_SIZE_GB = 10;
export const HETZNER_VOLUME_MAX_SIZE_GB = 10_000;
export const HETZNER_MAX_VOLUMES_PER_SERVER = 16;
// 100 pages × 25 items/page ≈ 2,500 resources — well above any realistic fleet
export const DEFAULT_HETZNER_MAX_LIST_PAGES = 100;

export function recordHetznerListPage(
  seenPages: Set<number>,
  page: number,
  operation: 'listVMs' | 'listVolumes'
): void {
  if (seenPages.has(page)) {
    throw new ProviderError(
      'hetzner',
      undefined,
      `Hetzner ${operation} pagination repeated page ${page}`,
      { category: 'invalid_config' }
    );
  }
  seenPages.add(page);
}

export function buildHetznerListUrl(
  resource: 'servers' | 'volumes',
  baseParams: URLSearchParams,
  labelParts: string[],
  page: number
): string {
  const params = new URLSearchParams(baseParams);
  if (labelParts.length > 0) params.set('label_selector', labelParts.join(','));
  if (page !== 1) params.set('page', String(page));
  const queryString = params.toString();
  return queryString
    ? `${HETZNER_API_URL}/${resource}?${queryString}`
    : `${HETZNER_API_URL}/${resource}`;
}

export const HETZNER_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: HETZNER_VOLUME_MIN_SIZE_GB,
  maxSizeGb: HETZNER_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  maxAttachedVolumesPerServer: HETZNER_MAX_VOLUMES_PER_SERVER,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
};

export interface HetznerProviderRuntimeOptions {
  capacityRetryMaxAttempts?: number;
  capacityRetryBudgetMs?: number;
  logger?: ProviderLogger;
}

const UNSUPPORTED_LOCATION_CAPACITY_PATTERN =
  /^(?:hetzner API error \(422\): )?unsupported location for server type$/i;

/**
 * Fallback message patterns for transient capacity detection when the structured
 * `error.code` is unavailable. Secondary heuristic only — prefer `providerCode`.
 */
const TRANSIENT_CAPACITY_PATTERNS: RegExp[] = [
  /unavailable/i,
  /currently not available/i,
  /no capacity/i,
  /not enough resources/i,
  /resource[s]?\s+(?:temporarily\s+)?unavailable/i,
  /could not (?:find|allocate)/i,
  UNSUPPORTED_LOCATION_CAPACITY_PATTERN,
];

/**
 * Hetzner has returned this capacity condition as `invalid_input` in production.
 * Keep this override narrow: other `invalid_input` responses are permanent config errors.
 */
const INVALID_INPUT_CAPACITY_PATTERNS: RegExp[] = [UNSUPPORTED_LOCATION_CAPACITY_PATTERN];

/**
 * Classify a Hetzner API error into a normalized ProviderErrorCategory.
 *
 * Primary signal: structured `error.code` from the JSON response, except for a
 * narrow allowlist of production-observed conflicting signals.
 * Fallback: message regex patterns for cases where the code is missing.
 *
 * Hetzner error codes (from API docs):
 * - resource_unavailable → transient_capacity
 * - uniqueness_error → invalid_config
 * - invalid_input → invalid_config
 * - forbidden → auth_error
 * - unauthorized → auth_error
 * - rate_limit_exceeded → rate_limited
 * - conflict → invalid_config
 * - server_limit_exceeded → quota_exceeded
 * - placement_error → invalid_config (handled separately as 412)
 */
export function classifyHetznerError(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string
): ProviderErrorCategory {
  // The exact capacity message is more specific than Hetzner's generic invalid_input code.
  if (
    statusCode === 422 &&
    providerCode === 'invalid_input' &&
    INVALID_INPUT_CAPACITY_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return 'transient_capacity';
  }

  if (providerCode) {
    switch (providerCode) {
      case 'resource_unavailable':
        return 'transient_capacity';
      case 'server_limit_exceeded':
        return 'quota_exceeded';
      case 'uniqueness_error':
      case 'invalid_input':
      case 'conflict':
      case 'placement_error':
        return 'invalid_config';
      case 'forbidden':
      case 'unauthorized':
        return 'auth_error';
      case 'rate_limit_exceeded':
        return 'rate_limited';
    }
  }

  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';

  if (statusCode === 422 && TRANSIENT_CAPACITY_PATTERNS.some((pattern) => pattern.test(message))) {
    return 'transient_capacity';
  }

  return 'unknown';
}

/**
 * Determine whether a ProviderError represents a transient capacity issue.
 * Uses the normalized `category` field as primary signal, with fallback
 * classification for errors that don't have a category set.
 */
export function isTransientCapacityError(err: ProviderError): boolean {
  if (err.category === 'transient_capacity') return true;
  if (err.statusCode === 422 && err.category === 'unknown') {
    return (
      classifyHetznerError(err.statusCode, err.providerCode, err.message) === 'transient_capacity'
    );
  }
  return false;
}

export function isAlreadyDetachedVolumeError(err: ProviderError): boolean {
  return err.statusCode === 422 && /volume/i.test(err.message) && /not attached/i.test(err.message);
}

export const HETZNER_SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'cx23',
    price: '€3.99/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 40,
  },
  medium: {
    type: 'cx33',
    price: '€7.49/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 80,
  },
  large: {
    type: 'cx43',
    price: '€14.49/mo',
    vcpu: 8,
    ramGb: 16,
    storageGb: 160,
  },
};

export function mapHetznerServerToVMInstance(server: HetznerServerPayload): VMInstance {
  return {
    id: String(server.id),
    name: server.name,
    ip: server.public_net.ipv4.ip,
    status: mapHetznerStatus(server.status),
    serverType: server.server_type.name,
    createdAt: server.created,
    labels: server.labels,
  };
}

export function mapHetznerVolumeToInstance(volume: HetznerVolumePayload): VolumeInstance {
  return {
    id: String(volume.id),
    name: volume.name,
    sizeGb: volume.size,
    location: volume.location.name,
    status: mapHetznerVolumeStatus(volume.status),
    ...(volume.server ? { attachedServerId: String(volume.server.id) } : {}),
    ...(volume.linux_device ? { linuxDevice: volume.linux_device } : {}),
    createdAt: volume.created,
    labels: volume.labels,
  };
}

function mapHetznerVolumeStatus(status: string): VolumeStatus {
  switch (status) {
    case 'creating':
      return 'creating';
    case 'available':
      return 'available';
    case 'in-use':
      return 'attached';
    default:
      return 'unknown';
  }
}

function mapHetznerStatus(status: string): VMStatus {
  switch (status) {
    case 'initializing':
    case 'running':
    case 'off':
    case 'starting':
    case 'stopping':
      return status;
    default:
      return 'initializing';
  }
}

export function mapHetznerProviderError(err: unknown): unknown {
  if (!(err instanceof ProviderError)) return err;
  return new ProviderError('hetzner', err.statusCode, err.message, {
    cause: err,
    providerCode: err.providerCode,
    category: classifyHetznerError(err.statusCode, err.providerCode, err.message),
  });
}
