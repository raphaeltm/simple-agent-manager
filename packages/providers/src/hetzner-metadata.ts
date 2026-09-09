import type { VMSize } from '@simple-agent-manager/shared';

import { observedHardware } from './native-vm-config';
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
  operation: 'listVMs' | 'listVolumes' | 'listInstanceOfferings'
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
  resource: 'servers' | 'volumes' | 'server_types',
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

export function validateHetznerVolumeSize(sizeGb: number): void {
  if (!Number.isInteger(sizeGb) || sizeGb < HETZNER_VOLUME_MIN_SIZE_GB) {
    throw new ProviderError(
      'hetzner',
      undefined,
      `Hetzner volume size must be an integer >= ${HETZNER_VOLUME_MIN_SIZE_GB}GB`,
      { category: 'invalid_config' }
    );
  }
  if (sizeGb > HETZNER_VOLUME_MAX_SIZE_GB) {
    throw new ProviderError(
      'hetzner',
      undefined,
      `Hetzner volume size must be <= ${HETZNER_VOLUME_MAX_SIZE_GB}GB`,
      { category: 'invalid_config' }
    );
  }
}

export interface HetznerProviderRuntimeOptions {
  capacityRetryMaxAttempts?: number;
  capacityRetryBudgetMs?: number;
  maxListPages?: number;
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
 * Hetzner 412 placement failures. Observed in production as
 * `hetzner API error (412): error during placement`.
 *
 * A placement failure says Hetzner cannot place THIS server type in THIS location right now.
 * Nothing about the request is invalid, so it is capacity scarcity, not `invalid_config`.
 * Used as the message fallback for a 412 whose structured `error.code` is absent or unrecognized.
 */
const PLACEMENT_CAPACITY_PATTERNS: RegExp[] = [/placement/i];

/** Hetzner's structured error code for a placement failure. */
const HETZNER_PLACEMENT_ERROR_CODE = 'placement_error';

/** HTTP status Hetzner returns for a placement failure. */
const HETZNER_PLACEMENT_STATUS_CODE = 412;

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
      // A placement failure is capacity scarcity for one server type in one location, NOT a
      // config error. Classifying it `invalid_config` made `node-provisioning-step` take its
      // "any non-capacity provider failure fails fast — never descend" branch, so a pool with
      // `exhaustionPolicy: fallback-chain` terminalized on its first offering and never tried
      // the rest. See tasks/archive/2026-09-09-hetzner-412-placement-blocks-fallback-chain.md.
      case HETZNER_PLACEMENT_ERROR_CODE:
        return 'transient_capacity';
      case 'server_limit_exceeded':
        return 'quota_exceeded';
      case 'uniqueness_error':
      case 'invalid_input':
      case 'conflict':
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

  // Production only proves the status code and message for this case: the observability record
  // for the 2026-09-09 incident carried `statusCode: 412` and "error during placement" but no
  // structured code. Do not rely on `placement_error` being present.
  if (
    statusCode === HETZNER_PLACEMENT_STATUS_CODE &&
    PLACEMENT_CAPACITY_PATTERNS.some((pattern) => pattern.test(message))
  ) {
    return 'transient_capacity';
  }

  return 'unknown';
}

/**
 * A Hetzner placement failure specifically, as opposed to capacity scarcity in general.
 *
 * Composed as its own predicate rather than reusing `isTransientCapacityError` because the two
 * answer different questions and drive different actions (`.claude/rules/67`):
 *
 *   isTransientCapacityError  "should the CONTROL PLANE try a different offering?"  -> yes
 *   isHetznerPlacementCapacityError  "should the PROVIDER retry this same SKU?"     -> no
 *
 * `createVM`'s outer capacity loop waits up to `DEFAULT_CAPACITY_RETRY_BUDGET_MS` (300 s) on the
 * requested server type. That is right for a generic capacity error and wrong for a placement
 * failure: the pool already holds other offerings, and choosing between them is a control-plane
 * decision (see `attemptCreateWithPlacementFallback`'s "Cross-location fallback must be a new
 * control-plane placement decision"). Before this change a 412 escaped that loop immediately, so
 * excluding it here keeps provisioning latency exactly as it is today.
 */
export function isHetznerPlacementCapacityError(err: ProviderError): boolean {
  if (err.statusCode !== HETZNER_PLACEMENT_STATUS_CODE) return false;
  if (err.providerCode === HETZNER_PLACEMENT_ERROR_CODE) return true;
  if (err.providerCode !== undefined) return false;
  return PLACEMENT_CAPACITY_PATTERNS.some((pattern) => pattern.test(err.message));
}

/**
 * Determine whether a ProviderError represents a transient capacity issue.
 * Uses the normalized `category` field as primary signal, with fallback
 * classification for errors that don't have a category set.
 */
export function isTransientCapacityError(err: ProviderError): boolean {
  if (err.category === 'transient_capacity') return true;
  // `providerFetch` constructs every HTTP ProviderError with `{ providerCode }` and no
  // `category`, so the create path always arrives here as 'unknown' and the classifier is the
  // only thing that can answer. Kept to the two status codes with production-observed capacity
  // semantics (422 scarcity, 412 placement) rather than opened to every status, so this stays a
  // reviewable hotfix. Without the 412 arm, fixing `classifyHetznerError` alone changes nothing
  // in production while its unit tests go green (`.claude/rules/62`).
  if (
    (err.statusCode === 422 || err.statusCode === HETZNER_PLACEMENT_STATUS_CODE) &&
    err.category === 'unknown'
  ) {
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
  const resources =
    server.server_type.cores !== undefined &&
    server.server_type.memory !== undefined &&
    server.server_type.disk !== undefined
      ? {
          vcpuCount: server.server_type.cores,
          memoryMb: server.server_type.memory * 1024,
          diskGb: server.server_type.disk,
        }
      : null;

  return {
    id: String(server.id),
    name: server.name,
    ...(server.location ? { location: server.location.name } : {}),
    ip: server.public_net.ipv4.ip,
    status: mapHetznerStatus(server.status),
    serverType: server.server_type.name,
    observedHardware: observedHardware({
      serverType: server.server_type.name,
      resources,
      unknownResourcesReason: 'Hetzner response omitted server_type resource fields',
    }),
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
