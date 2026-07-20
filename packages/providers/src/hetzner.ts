import type { VMSize } from '@simple-agent-manager/shared';
import { DEFAULT_HETZNER_DATACENTER, DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import { providerFetch } from './provider-fetch';
import type {
  LocationMeta,
  Provider,
  ProviderErrorCategory,
  ProviderLogger,
  SizeConfig,
  VMConfig,
  VMInstance,
  VMStatus,
  VolumeAttachmentConfig,
  VolumeCapabilities,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
  VolumeStatus,
} from './types';
import {
  noopProviderLogger,
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import {
  type HetznerServerPayload,
  type HetznerVolumePayload,
  parseProviderJson,
  validateHetznerServerResponse,
  validateHetznerServersResponse,
  validateHetznerVolumeResponse,
  validateHetznerVolumesResponse,
} from './validation';

const HETZNER_API_URL = 'https://api.hetzner.cloud/v1';

const HETZNER_LOCATIONS = ['fsn1', 'nbg1', 'hel1', 'ash', 'hil'] as const;

const HETZNER_LOCATION_META: Record<string, LocationMeta> = {
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

const HETZNER_VOLUME_CAPABILITIES: VolumeCapabilities = {
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
  /unsupported location for server type/i,
];

/**
 * Classify a Hetzner API error into a normalized ProviderErrorCategory.
 *
 * Primary signal: structured `error.code` from the JSON response.
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
  message: string,
): ProviderErrorCategory {
  // Primary signal: structured error code
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

  // HTTP status code heuristics
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';

  // Fallback: message pattern matching for 422 without a recognized code
  if (statusCode === 422) {
    if (TRANSIENT_CAPACITY_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'transient_capacity';
    }
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
  // Fallback classification for errors without a pre-set category
  if (err.statusCode === 422 && err.category === 'unknown') {
    return classifyHetznerError(err.statusCode, err.providerCode, err.message) === 'transient_capacity';
  }
  return false;
}

function isAlreadyDetachedVolumeError(err: ProviderError): boolean {
  return (
    err.statusCode === 422 &&
    /volume/i.test(err.message) &&
    /not attached/i.test(err.message)
  );
}

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
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

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  readonly locations: readonly string[] = HETZNER_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = HETZNER_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;
  readonly volumeCapabilities: VolumeCapabilities = HETZNER_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;

  private readonly apiToken: string;
  private readonly datacenter: string;
  private readonly placementRetryDelayMs: number;
  private readonly placementFallbackEnabled: boolean;
  private readonly capacityRetryInitialDelayMs: number;
  private readonly capacityRetryMaxDelayMs: number;
  private readonly capacityRetryMaxAttempts: number;
  private readonly capacityRetryBudgetMs: number;
  private readonly logger: ProviderLogger;

  constructor(
    apiToken: string,
    datacenter?: string,
    placementRetryDelayMs?: number,
    placementFallbackEnabled?: boolean,
    capacityRetryInitialDelayMs?: number,
    capacityRetryMaxDelayMs?: number,
    capacityRetryMaxAttemptsOrOptions?: number | HetznerProviderRuntimeOptions,
  ) {
    const runtimeOptions = typeof capacityRetryMaxAttemptsOrOptions === 'object'
      ? capacityRetryMaxAttemptsOrOptions
      : undefined;
    const capacityRetryMaxAttempts = typeof capacityRetryMaxAttemptsOrOptions === 'number'
      ? capacityRetryMaxAttemptsOrOptions
      : runtimeOptions?.capacityRetryMaxAttempts;

    this.apiToken = apiToken;
    this.datacenter = datacenter || DEFAULT_HETZNER_DATACENTER;
    this.defaultLocation = this.datacenter;
    this.placementRetryDelayMs = placementRetryDelayMs ?? DEFAULT_PLACEMENT_RETRY_DELAY_MS;
    this.placementFallbackEnabled = placementFallbackEnabled ?? true;
    this.capacityRetryInitialDelayMs =
      capacityRetryInitialDelayMs ?? DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS;
    this.capacityRetryMaxDelayMs =
      capacityRetryMaxDelayMs ?? DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS;
    this.capacityRetryMaxAttempts =
      capacityRetryMaxAttempts ?? DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS;
    this.capacityRetryBudgetMs =
      runtimeOptions?.capacityRetryBudgetMs ?? DEFAULT_CAPACITY_RETRY_BUDGET_MS;
    this.logger = runtimeOptions?.logger ?? noopProviderLogger;
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }

    const deadline = Date.now() + this.capacityRetryBudgetMs;
    let lastCapacityError: ProviderError | undefined;

    for (let capacityAttempt = 0; capacityAttempt < this.capacityRetryMaxAttempts; capacityAttempt++) {
      try {
        return await this.attemptCreateWithPlacementFallback(config, sizeConfig);
      } catch (err) {
        if (err instanceof ProviderError && isTransientCapacityError(err)) {
          lastCapacityError = err;
          const delay = this.computeCapacityRetryDelay(capacityAttempt);
          const isLastAttempt = capacityAttempt >= this.capacityRetryMaxAttempts - 1;
          const wouldExceedBudget = Date.now() + delay > deadline;

          if (isLastAttempt || wouldExceedBudget) {
            throw new ProviderError(
              this.name,
              422,
              `Capacity exhausted after ${capacityAttempt + 1} attempts for ` +
                `server type ${sizeConfig.type} in ${config.location || this.datacenter}: ` +
                err.message,
              { cause: err, category: 'transient_capacity' },
            );
          }

          this.logger.warn('hetzner transient capacity error; retrying createVM', {
            delayMs: delay,
            attempt: capacityAttempt + 1,
            maxAttempts: this.capacityRetryMaxAttempts,
            budgetRemainingMs: Math.max(0, deadline - Date.now()),
            serverType: sizeConfig.type,
            location: config.location || this.datacenter,
            statusCode: err.statusCode,
            providerCode: err.providerCode,
          });

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }

    // Unreachable, but TypeScript needs it
    throw new ProviderError(this.name, undefined, 'Capacity retry loop exited unexpectedly', {
      cause: lastCapacityError,
    });
  }

  /**
   * Compute exponential backoff delay for capacity retries.
   * delay = min(initialDelay * 2^attempt, maxDelay)
   */
  private computeCapacityRetryDelay(attempt: number): number {
    const delay = this.capacityRetryInitialDelayMs * Math.pow(2, attempt);
    return Math.min(delay, this.capacityRetryMaxDelayMs);
  }

  /**
   * Inner placement loop: tries the primary location (twice with a delay),
   * then falls back to other locations on 412 placement errors.
   */
  private async attemptCreateWithPlacementFallback(
    config: VMConfig,
    sizeConfig: SizeConfig,
  ): Promise<VMInstance> {
    const primaryLocation = config.location || this.datacenter;

    const fallbackLocations = this.placementFallbackEnabled
      ? HETZNER_LOCATIONS.filter((loc) => loc !== primaryLocation)
      : [];
    const attemptsToTry: Array<{ location: string; delayMs: number }> = [
      { location: primaryLocation, delayMs: 0 },
      { location: primaryLocation, delayMs: this.placementRetryDelayMs },
      ...fallbackLocations.map((loc) => ({ location: loc, delayMs: 0 })),
    ];

    let lastError: ProviderError | undefined;
    for (const attempt of attemptsToTry) {
      if (lastError && attempt.delayMs > 0) {
        this.logger.warn('hetzner retrying primary placement after delay', {
          location: attempt.location,
          delayMs: attempt.delayMs,
        });
        await new Promise((resolve) => setTimeout(resolve, attempt.delayMs));
      }

      try {
        const response = await providerFetch(this.name, `${HETZNER_API_URL}/servers`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: config.name,
            server_type: sizeConfig.type,
            image: config.image || DEFAULT_HETZNER_IMAGE,
            location: attempt.location,
            user_data: config.userData,
            labels: config.labels || {},
            start_after_create: true,
          }),
        });

        const data = validateHetznerServerResponse(
          await parseProviderJson(response, this.name, 'createVM'),
          'createVM',
        );
        if (attempt.location !== primaryLocation) {
          this.logger.info('hetzner placement fallback succeeded', {
            primaryLocation,
            selectedLocation: attempt.location,
          });
        }
        return this.mapServerToVMInstance(data.server);
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 412) {
          this.logger.warn('hetzner placement attempt failed', {
            location: attempt.location,
            statusCode: err.statusCode,
          });
          lastError = err;
          continue;
        }
        throw err; // Non-placement errors bubble up (including transient 422s)
      }
    }

    if (lastError) throw lastError;
    throw new ProviderError(this.name, undefined, 'No Hetzner placement attempts were available');
  }

  async deleteVM(id: string): Promise<void> {
    try {
      await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent: already deleted
      }
      throw err;
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    try {
      const response = await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      const data = validateHetznerServerResponse(
        await parseProviderJson(response, this.name, 'getVM'),
        'getVM',
      );
      return this.mapServerToVMInstance(data.server);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const labelParts: string[] = [];
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        labelParts.push(`${key}=${value}`);
      }
    }

    const url = labelParts.length > 0
      ? `${HETZNER_API_URL}/servers?label_selector=${encodeURIComponent(labelParts.join(','))}`
      : `${HETZNER_API_URL}/servers`;

    const response = await providerFetch(this.name, url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    const data = validateHetznerServersResponse(
      await parseProviderJson(response, this.name, 'listVMs'),
      'listVMs',
    );
    return data.servers.map((server) => this.mapServerToVMInstance(server));
  }

  async powerOff(id: string): Promise<void> {
    await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}/actions/poweroff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async powerOn(id: string): Promise<void> {
    await providerFetch(this.name, `${HETZNER_API_URL}/servers/${id}/actions/poweron`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async validateToken(): Promise<boolean> {
    await providerFetch(this.name, `${HETZNER_API_URL}/datacenters`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
    return true;
  }

  async createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);

    let response: Response;
    try {
      response = await providerFetch(this.name, `${HETZNER_API_URL}/volumes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: config.name,
          size: config.sizeGb,
          location: config.location,
          format: config.format ?? SAM_VOLUME_FILESYSTEM_FORMAT,
          labels: config.labels || {},
        }),
      });
    } catch (err) {
      throw this.mapProviderError(err);
    }

    const data = validateHetznerVolumeResponse(
      await parseProviderJson(response, this.name, 'createVolume'),
      'createVolume',
    );
    return this.mapVolumeToInstance(data.volume);
  }

  async attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/attach`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          server: Number(config.serverId),
          automount: false,
        }),
      },
    );

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError(this.name, 404, `Hetzner volume ${config.volumeId} not found after attach`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    try {
      await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/detach`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
      );
    } catch (err) {
      if (err instanceof ProviderError) {
        if (err.statusCode === 404) {
          return null;
        }
        if (isAlreadyDetachedVolumeError(err)) {
          return this.getVolume({ volumeId: config.volumeId, location: config.location });
        }
      }
      throw err;
    }

    return this.getVolume({ volumeId: config.volumeId, location: config.location });
  }

  async resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);
    const currentSizeGb = config.currentSizeGb ?? await this.getCurrentVolumeSize(config);
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        this.name,
        undefined,
        `Cannot shrink Hetzner volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' },
      );
    }

    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/resize`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ size: config.sizeGb }),
      },
    );

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError(this.name, 404, `Hetzner volume ${config.volumeId} not found after resize`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    try {
      await providerFetch(this.name, `${HETZNER_API_URL}/volumes/${config.volumeId}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    try {
      const response = await providerFetch(this.name, `${HETZNER_API_URL}/volumes/${config.volumeId}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      const data = validateHetznerVolumeResponse(
        await parseProviderJson(response, this.name, 'getVolume'),
        'getVolume',
      );
      return this.mapVolumeToInstance(data.volume);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    const labelParts: string[] = [];
    if (config.labels) {
      for (const [key, value] of Object.entries(config.labels)) {
        labelParts.push(`${key}=${value}`);
      }
    }

    const params = new URLSearchParams({ location: config.location });
    if (labelParts.length > 0) {
      params.set('label_selector', labelParts.join(','));
    }

    const response = await providerFetch(this.name, `${HETZNER_API_URL}/volumes?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    const data = validateHetznerVolumesResponse(
      await parseProviderJson(response, this.name, 'listVolumes'),
      'listVolumes',
    );
    return data.volumes.map((volume) => this.mapVolumeToInstance(volume));
  }

  private mapServerToVMInstance(server: HetznerServerPayload): VMInstance {
    return {
      id: String(server.id),
      name: server.name,
      ip: server.public_net.ipv4.ip,
      status: this.mapStatus(server.status),
      serverType: server.server_type.name,
      createdAt: server.created,
      labels: server.labels,
    };
  }

  private mapVolumeToInstance(volume: HetznerVolumePayload): VolumeInstance {
    return {
      id: String(volume.id),
      name: volume.name,
      sizeGb: volume.size,
      location: volume.location.name,
      status: this.mapVolumeStatus(volume.status),
      ...(volume.server ? { attachedServerId: String(volume.server.id) } : {}),
      ...(volume.linux_device ? { linuxDevice: volume.linux_device } : {}),
      createdAt: volume.created,
      labels: volume.labels,
    };
  }

  private mapVolumeStatus(status: string): VolumeStatus {
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

  private validateRequestedVolumeSize(sizeGb: number): void {
    if (!Number.isInteger(sizeGb) || sizeGb < HETZNER_VOLUME_MIN_SIZE_GB) {
      throw new ProviderError(
        this.name,
        undefined,
        `Hetzner volume size must be an integer >= ${HETZNER_VOLUME_MIN_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
    if (sizeGb > HETZNER_VOLUME_MAX_SIZE_GB) {
      throw new ProviderError(
        this.name,
        undefined,
        `Hetzner volume size must be <= ${HETZNER_VOLUME_MAX_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
  }

  private async getCurrentVolumeSize(config: VolumeResizeConfig): Promise<number> {
    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError(this.name, 404, `Hetzner volume ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }

  private mapProviderError(err: unknown): unknown {
    if (!(err instanceof ProviderError)) return err;
    return new ProviderError(this.name, err.statusCode, err.message, {
      cause: err,
      providerCode: err.providerCode,
      category: classifyHetznerError(err.statusCode, err.providerCode, err.message),
    });
  }

  private mapStatus(hetznerStatus: string): VMStatus {
    switch (hetznerStatus) {
      case 'initializing':
      case 'running':
      case 'off':
      case 'starting':
      case 'stopping':
        return hetznerStatus;
      default:
        return 'initializing';
    }
  }
}
