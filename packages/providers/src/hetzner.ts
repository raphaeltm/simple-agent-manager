import type { VMSize } from '@simple-agent-manager/shared';
import { DEFAULT_HETZNER_DATACENTER, DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import {
  getRetryDelayMs,
  getRetryMaxAttempts,
  getTimeoutMs,
  providerFetch,
  providerFetchWithRetry,
} from './provider-fetch';
import type { LocationMeta, Provider, SizeConfig, VMConfig, VMInstance, VMStatus } from './types';
import { ProviderError } from './types';

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
export const DEFAULT_PLACEMENT_RETRY_ATTEMPTS = 2;

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

interface HetznerServerResponse {
  server: {
    id: number;
    name: string;
    status: string;
    public_net: {
      ipv4: {
        ip: string;
      };
    };
    server_type: {
      name: string;
    };
    created: string;
    labels: Record<string, string>;
  };
}

interface HetznerServersResponse {
  servers: HetznerServerResponse['server'][];
}

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  readonly locations: readonly string[] = HETZNER_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = HETZNER_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;
  readonly defaultLocation: string;

  private readonly apiToken: string;
  private readonly datacenter: string;
  private readonly timeoutMs: number;
  private readonly apiRetryMaxAttempts: number;
  private readonly apiRetryBaseDelayMs: number;
  private readonly apiRetryMaxDelayMs: number;
  private readonly placementRetryDelayMs: number;
  private readonly placementRetryAttempts: number;
  private readonly placementFallbackEnabled: boolean;
  private readonly placementFallbackLocations: string[] | undefined;

  constructor(
    apiToken: string,
    datacenter?: string,
    placementRetryDelayMs?: number,
    placementFallbackEnabled?: boolean,
    timeoutMs?: number,
    apiRetryMaxAttempts?: number,
    apiRetryBaseDelayMs?: number,
    apiRetryMaxDelayMs?: number,
    placementRetryAttempts?: number,
    placementFallbackLocations?: string[],
  ) {
    this.apiToken = apiToken;
    this.datacenter = datacenter || DEFAULT_HETZNER_DATACENTER;
    this.defaultLocation = this.datacenter;
    this.timeoutMs = getTimeoutMs(timeoutMs === undefined ? undefined : String(timeoutMs));
    this.apiRetryMaxAttempts = getRetryMaxAttempts(apiRetryMaxAttempts);
    this.apiRetryBaseDelayMs = getRetryDelayMs(apiRetryBaseDelayMs, 1_000);
    this.apiRetryMaxDelayMs = getRetryDelayMs(apiRetryMaxDelayMs, 10_000);
    this.placementRetryDelayMs = getRetryDelayMs(placementRetryDelayMs, DEFAULT_PLACEMENT_RETRY_DELAY_MS);
    this.placementRetryAttempts = getRetryMaxAttempts(placementRetryAttempts, DEFAULT_PLACEMENT_RETRY_ATTEMPTS);
    this.placementFallbackEnabled = placementFallbackEnabled ?? true;
    this.placementFallbackLocations = placementFallbackLocations?.filter((loc) => HETZNER_LOCATIONS.includes(loc as typeof HETZNER_LOCATIONS[number]));
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }
    const primaryLocation = config.location || this.datacenter;

    // Build attempt order: primary N times (with a delay between), then remaining locations.
    // Fallback order can be explicitly configured for deterministic capacity handling.
    const fallbackLocations = this.placementFallbackEnabled
      ? (this.placementFallbackLocations?.length
          ? this.placementFallbackLocations
          : HETZNER_LOCATIONS.filter((loc) => loc !== primaryLocation).sort(() => Math.random() - 0.5))
          .filter((loc) => loc !== primaryLocation)
      : [];
    const primaryAttempts = Array.from({ length: this.placementRetryAttempts }, (_, index) => ({
      location: primaryLocation,
      delayMs: index === 0 ? 0 : this.placementRetryDelayMs,
    }));
    const attemptsToTry: Array<{ location: string; delayMs: number }> = [
      ...primaryAttempts,
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
        }, this.timeoutMs);

        const data = (await response.json()) as HetznerServerResponse;
        if (attempt.location !== primaryLocation) {
          console.log(
            `hetzner: placement failed in ${primaryLocation}, succeeded in ${attempt.location}`,
          );
        }
        return this.mapServerToVMInstance(data.server);
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 412) {
          const placementError = new ProviderError(
            this.name,
            err.statusCode,
            err.message,
            {
              cause: err,
              retryable: true,
              reason: 'capacity',
              idempotencyRisk: 'duplicate_resource',
            },
          );
          console.warn(
            `hetzner: placement failed in ${attempt.location} (412)`,
          );
          lastError = placementError;
          continue;
        }
        throw err; // Non-placement errors are not retryable
      }
    }

    // All locations exhausted
    throw lastError!;
  }

  async deleteVM(id: string): Promise<void> {
    try {
      await this.fetch(`${HETZNER_API_URL}/servers/${id}`, {
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
      const response = await this.fetch(`${HETZNER_API_URL}/servers/${id}`, {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      });

      const data = (await response.json()) as HetznerServerResponse;
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

    const response = await this.fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });

    const data = (await response.json()) as HetznerServersResponse;
    return data.servers.map((server) => this.mapServerToVMInstance(server));
  }

  async powerOff(id: string): Promise<void> {
    await this.fetch(`${HETZNER_API_URL}/servers/${id}/actions/poweroff`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async powerOn(id: string): Promise<void> {
    await this.fetch(`${HETZNER_API_URL}/servers/${id}/actions/poweron`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
  }

  async validateToken(): Promise<boolean> {
    await this.fetch(`${HETZNER_API_URL}/datacenters`, {
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
      },
    });
    return true;
  }

  private fetch(url: string | URL, init?: RequestInit): Promise<Response> {
    return providerFetchWithRetry(this.name, url, init, this.timeoutMs, {
      maxAttempts: this.apiRetryMaxAttempts,
      baseDelayMs: this.apiRetryBaseDelayMs,
      maxDelayMs: this.apiRetryMaxDelayMs,
    });
  }

  private mapServerToVMInstance(server: HetznerServerResponse['server']): VMInstance {
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
