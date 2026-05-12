import type { VMSize } from '@simple-agent-manager/shared';
import { DEFAULT_HETZNER_DATACENTER, DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import { providerFetch } from './provider-fetch';
import type { LocationMeta, Provider, SizeConfig, VMConfig, VMInstance, VMStatus } from './types';
import { ProviderError } from './types';
import {
  type HetznerServerPayload,
  parseProviderJson,
  validateHetznerServerResponse,
  validateHetznerServersResponse,
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
export const DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS = 5;

/**
 * Known Hetzner 422 error message patterns that indicate transient capacity issues
 * rather than permanent configuration errors. Only 422s matching one of these
 * patterns are retried; all other 422s are treated as permanent failures.
 */
const TRANSIENT_CAPACITY_PATTERNS: RegExp[] = [
  /unavailable/i,
  /currently not available/i,
  /no capacity/i,
  /not enough resources/i,
  /resource[s]?\s+(?:temporarily\s+)?unavailable/i,
  /could not (?:find|allocate)/i,
];

/**
 * Determine whether a 422 ProviderError represents a transient capacity issue.
 * Conservative: only matches known capacity-related error messages.
 */
export function isTransientCapacityError(err: ProviderError): boolean {
  if (err.statusCode !== 422) return false;
  return TRANSIENT_CAPACITY_PATTERNS.some((pattern) => pattern.test(err.message));
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
  readonly defaultLocation: string;

  private readonly apiToken: string;
  private readonly datacenter: string;
  private readonly placementRetryDelayMs: number;
  private readonly placementFallbackEnabled: boolean;
  private readonly capacityRetryInitialDelayMs: number;
  private readonly capacityRetryMaxDelayMs: number;
  private readonly capacityRetryMaxAttempts: number;

  constructor(
    apiToken: string,
    datacenter?: string,
    placementRetryDelayMs?: number,
    placementFallbackEnabled?: boolean,
    capacityRetryInitialDelayMs?: number,
    capacityRetryMaxDelayMs?: number,
    capacityRetryMaxAttempts?: number,
  ) {
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
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }

    for (let capacityAttempt = 0; capacityAttempt < this.capacityRetryMaxAttempts; capacityAttempt++) {
      try {
        return await this.attemptCreateWithPlacementFallback(config, sizeConfig);
      } catch (err) {
        if (err instanceof ProviderError && isTransientCapacityError(err)) {
          const delay = this.computeCapacityRetryDelay(capacityAttempt);
          const isLastAttempt = capacityAttempt >= this.capacityRetryMaxAttempts - 1;

          if (isLastAttempt) {
            throw new ProviderError(
              this.name,
              422,
              `Capacity exhausted after ${capacityAttempt + 1} attempts for ` +
                `server type ${sizeConfig.type} in ${config.location || this.datacenter}: ` +
                err.message,
              { cause: err },
            );
          }

          console.warn(
            `hetzner: transient capacity error, retrying in ${delay}ms ` +
              `(attempt ${capacityAttempt + 1}/${this.capacityRetryMaxAttempts}, ` +
              `server_type=${sizeConfig.type}, ` +
              `location=${config.location || this.datacenter}, ` +
              `error=${err.message})`,
          );

          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw err;
      }
    }

    // Unreachable, but TypeScript needs it
    throw new ProviderError(this.name, undefined, 'Capacity retry loop exited unexpectedly');
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
        console.warn(
          `hetzner: retrying ${attempt.location} after ${attempt.delayMs}ms`,
        );
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
          console.log(
            `hetzner: placement failed in ${primaryLocation}, succeeded in ${attempt.location}`,
          );
        }
        return this.mapServerToVMInstance(data.server);
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 412) {
          console.warn(
            `hetzner: placement failed in ${attempt.location} (412)`,
          );
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
