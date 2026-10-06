import type { CredentialProvider, ProviderInstanceOffering } from '@simple-agent-manager/shared';
import { DEFAULT_HETZNER_DATACENTER, DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import { mapHetznerServerTypeOfferings } from './hetzner-instance-offerings';
import {
  DEFAULT_CAPACITY_RETRY_BUDGET_MS,
  DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS,
  DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS,
  DEFAULT_HETZNER_MAX_LIST_PAGES,
  DEFAULT_PLACEMENT_RETRY_DELAY_MS,
  HETZNER_API_URL,
  HETZNER_LOCATION_META,
  HETZNER_LOCATIONS,
  HETZNER_SIZE_CONFIGS,
  HETZNER_VOLUME_CAPABILITIES,
  type HetznerProviderRuntimeOptions,
  mapHetznerServerToVMInstance,
} from './hetzner-metadata';
import { fetchPaginatedHetznerList, hetznerLabelSelectorParts } from './hetzner-pagination';
import { HetznerServerCreate } from './hetzner-server-create';
import { HetznerVolumes } from './hetzner-volumes';
import { getProviderCatalogOfferings } from './instance-offerings';
import {
  assertIncludedBootDiskCapacity,
  resolveVMConfigWithLegacySizeAdapter,
} from './native-vm-config';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  LocationMeta,
  Provider,
  ProviderLogger,
  ProviderOfferingListOptions,
  ProviderRequestContext,
  VMConfig,
  VMInstance,
  VolumeAttachmentConfig,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
} from './types';
import { noopProviderLogger, ProviderError } from './types';
import {
  type HetznerServerPayload,
  type HetznerServerTypePayload,
  parseProviderJson,
  validateHetznerServerResponse,
  validateHetznerServersResponse,
  validateHetznerServerTypesResponse,
} from './validation';

export type { HetznerProviderRuntimeOptions } from './hetzner-metadata';
export {
  classifyHetznerError,
  DEFAULT_CAPACITY_RETRY_BUDGET_MS,
  DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS,
  DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS,
  DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS,
  DEFAULT_HETZNER_MAX_LIST_PAGES,
  DEFAULT_PLACEMENT_RETRY_DELAY_MS,
  HETZNER_MAX_VOLUMES_PER_SERVER,
  HETZNER_VOLUME_MAX_SIZE_GB,
  HETZNER_VOLUME_MIN_SIZE_GB,
  isHetznerPlacementCapacityError,
  isTransientCapacityError,
} from './hetzner-metadata';

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  readonly locations: readonly string[] = HETZNER_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = HETZNER_LOCATION_META;
  readonly sizes = HETZNER_SIZE_CONFIGS;
  readonly volumeCapabilities = HETZNER_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;
  /** listInstanceOfferings reads the live /server_types API and throws instead of falling back. */
  readonly instanceOfferingApiBacked = true;

  private readonly apiToken: string;
  private readonly datacenter: string;
  private readonly placementFallbackEnabled: boolean;
  private readonly maxListPages: number;
  private readonly logger: ProviderLogger;
  private readonly serverCreate: HetznerServerCreate;
  private readonly volumes: HetznerVolumes;

  constructor(
    apiToken: string,
    datacenter?: string,
    placementRetryDelayMs?: number,
    placementFallbackEnabled?: boolean,
    capacityRetryInitialDelayMs?: number,
    capacityRetryMaxDelayMs?: number,
    capacityRetryMaxAttemptsOrOptions?: number | HetznerProviderRuntimeOptions
  ) {
    const runtimeOptions =
      typeof capacityRetryMaxAttemptsOrOptions === 'object'
        ? capacityRetryMaxAttemptsOrOptions
        : undefined;
    const capacityRetryMaxAttempts =
      typeof capacityRetryMaxAttemptsOrOptions === 'number'
        ? capacityRetryMaxAttemptsOrOptions
        : runtimeOptions?.capacityRetryMaxAttempts;

    this.apiToken = apiToken;
    this.datacenter = datacenter || DEFAULT_HETZNER_DATACENTER;
    this.defaultLocation = this.datacenter;
    this.placementFallbackEnabled = placementFallbackEnabled ?? true;
    this.maxListPages = runtimeOptions?.maxListPages ?? DEFAULT_HETZNER_MAX_LIST_PAGES;
    this.volumes = new HetznerVolumes(apiToken, this.maxListPages);
    this.logger = runtimeOptions?.logger ?? noopProviderLogger;
    this.serverCreate = new HetznerServerCreate(apiToken, {
      placementRetryDelayMs: placementRetryDelayMs ?? DEFAULT_PLACEMENT_RETRY_DELAY_MS,
      capacityRetryInitialDelayMs:
        capacityRetryInitialDelayMs ?? DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS,
      capacityRetryMaxDelayMs: capacityRetryMaxDelayMs ?? DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS,
      capacityRetryMaxAttempts: capacityRetryMaxAttempts ?? DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS,
      capacityRetryBudgetMs:
        runtimeOptions?.capacityRetryBudgetMs ?? DEFAULT_CAPACITY_RETRY_BUDGET_MS,
      logger: this.logger,
    });
  }

  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const nativeConfig = resolveVMConfigWithLegacySizeAdapter(config, {
      providerName: this.name,
      defaultLocation: this.datacenter,
      legacySizes: this.sizes,
      defaultImage: DEFAULT_HETZNER_IMAGE,
    });
    assertIncludedBootDiskCapacity(this.name, nativeConfig);
    // Native plans are authorized for one pool location. Cross-location
    // fallback must be a new control-plane placement decision.
    const allowLocationFallback = config.native === undefined && this.placementFallbackEnabled;

    return this.serverCreate.create(nativeConfig, allowLocationFallback, context);
  }

  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    try {
      await providerFetch(
        this.name,
        `${HETZNER_API_URL}/servers/${id}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        },
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent: already deleted
      }
      throw err;
    }
  }

  async getVM(id: string, context?: ProviderRequestContext): Promise<VMInstance | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await providerFetch(
        this.name,
        `${HETZNER_API_URL}/servers/${id}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        },
        undefined,
        undefined,
        context
      );

      throwIfProviderRequestAborted(context);
      const data = validateHetznerServerResponse(
        await parseProviderJson(response, this.name, 'getVM'),
        'getVM'
      );
      throwIfProviderRequestAborted(context);
      return mapHetznerServerToVMInstance(data.server);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const labelParts = hetznerLabelSelectorParts(labels);
    const servers: HetznerServerPayload[] = [];

    await fetchPaginatedHetznerList({
      apiToken: this.apiToken,
      resource: 'servers',
      baseParams: new URLSearchParams(),
      operation: 'listVMs',
      handlePage: (data) => {
        const validated = validateHetznerServersResponse(data, 'listVMs');
        servers.push(...validated.servers);
        return validated.nextPage;
      },
      labelParts,
      maxPages: this.maxListPages,
      context,
    });

    throwIfProviderRequestAborted(context);
    return servers.map(mapHetznerServerToVMInstance);
  }

  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/servers/${id}/actions/poweroff`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      },
      undefined,
      undefined,
      context
    );
  }

  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/servers/${id}/actions/poweron`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      },
      undefined,
      undefined,
      context
    );
  }

  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/datacenters`,
      {
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      },
      undefined,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    return true;
  }

  async listInstanceOfferings(
    options: ProviderOfferingListOptions = {},
    context?: ProviderRequestContext
  ): Promise<ProviderInstanceOffering[]> {
    if (options.preferApi === false) {
      return getProviderCatalogOfferings(
        this.name as CredentialProvider,
        this.locations,
        this.locationMetadata
      );
    }

    try {
      throwIfProviderRequestAborted(context);
      const serverTypes: HetznerServerTypePayload[] = [];
      const lastSeenAt = new Date().toISOString();

      await fetchPaginatedHetznerList({
        apiToken: this.apiToken,
        resource: 'server_types',
        baseParams: new URLSearchParams(),
        operation: 'listInstanceOfferings',
        handlePage: (data) => {
          const validated = validateHetznerServerTypesResponse(data, 'listInstanceOfferings');
          serverTypes.push(...validated.serverTypes);
          return validated.nextPage;
        },
        labelParts: [],
        maxPages: this.maxListPages,
        context,
      });

      throwIfProviderRequestAborted(context);
      return serverTypes.flatMap((serverType) =>
        mapHetznerServerTypeOfferings(serverType, lastSeenAt, this.locationMetadata)
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      const message =
        options.allowStaticFallback === false
          ? 'hetzner catalog API unavailable'
          : 'hetzner catalog API unavailable; using static instance offerings';
      this.logger.warn(message, {
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.allowStaticFallback === false) throw error;
      return getProviderCatalogOfferings(
        this.name as CredentialProvider,
        this.locations,
        this.locationMetadata
      );
    }
  }

  createVolume(config: VolumeConfig, context?: ProviderRequestContext): Promise<VolumeInstance> {
    return this.volumes.createVolume(config, context);
  }

  attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    return this.volumes.attachVolume(config, context);
  }

  detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    return this.volumes.detachVolume(config, context);
  }

  resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    return this.volumes.resizeVolume(config, context);
  }

  deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    return this.volumes.deleteVolume(config, context);
  }

  getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    return this.volumes.getVolume(config, context);
  }

  listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    return this.volumes.listVolumes(config, context);
  }
}
