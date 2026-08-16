import { DEFAULT_HETZNER_DATACENTER, DEFAULT_HETZNER_IMAGE } from '@simple-agent-manager/shared';

import {
  buildHetznerListUrl,
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
  HETZNER_VOLUME_MAX_SIZE_GB,
  HETZNER_VOLUME_MIN_SIZE_GB,
  type HetznerProviderRuntimeOptions,
  isAlreadyDetachedVolumeError,
  isTransientCapacityError,
  mapHetznerProviderError,
  mapHetznerServerToVMInstance,
  mapHetznerVolumeToInstance,
  recordHetznerListPage,
} from './hetzner-metadata';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  LocationMeta,
  Provider,
  ProviderLogger,
  ProviderRequestContext,
  SizeConfig,
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
import { noopProviderLogger, ProviderError, SAM_VOLUME_FILESYSTEM_FORMAT } from './types';
import {
  type HetznerServerPayload,
  type HetznerVolumePayload,
  parseProviderJson,
  validateHetznerServerResponse,
  validateHetznerServersResponse,
  validateHetznerVolumeResponse,
  validateHetznerVolumesResponse,
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
  isTransientCapacityError,
} from './hetzner-metadata';

export class HetznerProvider implements Provider {
  readonly name = 'hetzner';
  readonly locations: readonly string[] = HETZNER_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = HETZNER_LOCATION_META;
  readonly sizes = HETZNER_SIZE_CONFIGS;
  readonly volumeCapabilities = HETZNER_VOLUME_CAPABILITIES;
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
    this.placementRetryDelayMs = placementRetryDelayMs ?? DEFAULT_PLACEMENT_RETRY_DELAY_MS;
    this.placementFallbackEnabled = placementFallbackEnabled ?? true;
    this.capacityRetryInitialDelayMs =
      capacityRetryInitialDelayMs ?? DEFAULT_CAPACITY_RETRY_INITIAL_DELAY_MS;
    this.capacityRetryMaxDelayMs = capacityRetryMaxDelayMs ?? DEFAULT_CAPACITY_RETRY_MAX_DELAY_MS;
    this.capacityRetryMaxAttempts = capacityRetryMaxAttempts ?? DEFAULT_CAPACITY_RETRY_MAX_ATTEMPTS;
    this.capacityRetryBudgetMs =
      runtimeOptions?.capacityRetryBudgetMs ?? DEFAULT_CAPACITY_RETRY_BUDGET_MS;
    this.logger = runtimeOptions?.logger ?? noopProviderLogger;
  }

  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }

    const deadline = Date.now() + this.capacityRetryBudgetMs;
    let lastCapacityError: ProviderError | undefined;

    for (
      let capacityAttempt = 0;
      capacityAttempt < this.capacityRetryMaxAttempts;
      capacityAttempt++
    ) {
      try {
        return await this.attemptCreateWithPlacementFallback(config, sizeConfig, context);
      } catch (err) {
        lastCapacityError = await this.retryAfterCapacityError(
          err,
          capacityAttempt,
          deadline,
          config,
          sizeConfig,
          context
        );
      }
    }

    // Unreachable, but TypeScript needs it
    throw new ProviderError(this.name, undefined, 'Capacity retry loop exited unexpectedly', {
      cause: lastCapacityError,
    });
  }

  private async retryAfterCapacityError(
    error: unknown,
    attempt: number,
    deadline: number,
    config: VMConfig,
    sizeConfig: SizeConfig,
    context?: ProviderRequestContext
  ): Promise<ProviderError> {
    rethrowIfProviderRequestAborted(error, context);
    if (!(error instanceof ProviderError) || !isTransientCapacityError(error)) throw error;

    const delay = this.computeCapacityRetryDelay(attempt);
    const isLastAttempt = attempt >= this.capacityRetryMaxAttempts - 1;
    const wouldExceedBudget = Date.now() + delay > deadline;
    if (isLastAttempt || wouldExceedBudget) {
      throw new ProviderError(
        this.name,
        422,
        `Capacity exhausted after ${attempt + 1} attempts for ` +
          `server type ${sizeConfig.type} in ${config.location || this.datacenter}: ` +
          error.message,
        { cause: error, providerCode: error.providerCode, category: 'transient_capacity' }
      );
    }

    this.logger.warn('hetzner transient capacity error; retrying createVM', {
      delayMs: delay,
      attempt: attempt + 1,
      maxAttempts: this.capacityRetryMaxAttempts,
      budgetRemainingMs: Math.max(0, deadline - Date.now()),
      serverType: sizeConfig.type,
      location: config.location || this.datacenter,
      statusCode: error.statusCode,
      providerCode: error.providerCode,
    });
    await providerDelay(delay, context);
    return error;
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
    context?: ProviderRequestContext
  ): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
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
      throwIfProviderRequestAborted(context);
      if (lastError && attempt.delayMs > 0) {
        this.logger.warn('hetzner retrying primary placement after delay', {
          location: attempt.location,
          delayMs: attempt.delayMs,
        });
        await providerDelay(attempt.delayMs, context);
      }

      try {
        const response = await providerFetch(
          this.name,
          `${HETZNER_API_URL}/servers`,
          {
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
          },
          undefined,
          undefined,
          context
        );

        throwIfProviderRequestAborted(context);
        const data = validateHetznerServerResponse(
          await parseProviderJson(response, this.name, 'createVM'),
          'createVM'
        );
        throwIfProviderRequestAborted(context);
        if (attempt.location !== primaryLocation) {
          this.logger.info('hetzner placement fallback succeeded', {
            primaryLocation,
            selectedLocation: attempt.location,
          });
        }
        return mapHetznerServerToVMInstance(data.server);
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
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
    const labelParts = this.toHetznerLabelSelectorParts(labels);
    const servers: HetznerServerPayload[] = [];

    await this.fetchPaginatedHetznerList(
      'servers',
      new URLSearchParams(),
      'listVMs',
      (data) => {
        const validated = validateHetznerServersResponse(data, 'listVMs');
        servers.push(...validated.servers);
        return validated.nextPage;
      },
      labelParts,
      context
    );

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

  async createVolume(
    config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    this.validateRequestedVolumeSize(config.sizeGb);

    let response: Response;
    try {
      response = await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes`,
        {
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
        },
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      throw mapHetznerProviderError(err);
    }

    throwIfProviderRequestAborted(context);
    const data = validateHetznerVolumeResponse(
      await parseProviderJson(response, this.name, 'createVolume'),
      'createVolume'
    );
    throwIfProviderRequestAborted(context);
    return mapHetznerVolumeToInstance(data.volume);
  }

  async attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
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
      undefined,
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        this.name,
        404,
        `Hetzner volume ${config.volumeId} not found after attach`,
        {
          category: 'invalid_config',
        }
      );
    }
    return volume;
  }

  async detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
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
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError) {
        if (err.statusCode === 404) {
          return null;
        }
        if (isAlreadyDetachedVolumeError(err)) {
          return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
        }
      }
      throw err;
    }

    throwIfProviderRequestAborted(context);
    return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
  }

  async resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    this.validateRequestedVolumeSize(config.sizeGb);
    const currentSizeGb =
      config.currentSizeGb ?? (await this.getCurrentVolumeSize(config, context));
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        this.name,
        undefined,
        `Cannot shrink Hetzner volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' }
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
      undefined,
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        this.name,
        404,
        `Hetzner volume ${config.volumeId} not found after resize`,
        {
          category: 'invalid_config',
        }
      );
    }
    return volume;
  }

  async deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    try {
      await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}`,
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
        return;
      }
      throw err;
    }
  }

  async getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}`,
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
      const data = validateHetznerVolumeResponse(
        await parseProviderJson(response, this.name, 'getVolume'),
        'getVolume'
      );
      throwIfProviderRequestAborted(context);
      return mapHetznerVolumeToInstance(data.volume);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    const volumes: HetznerVolumePayload[] = [];

    await this.fetchPaginatedHetznerList(
      'volumes',
      new URLSearchParams({ location: config.location }),
      'listVolumes',
      (data) => {
        const validated = validateHetznerVolumesResponse(data, 'listVolumes');
        volumes.push(...validated.volumes);
        return validated.nextPage;
      },
      this.toHetznerLabelSelectorParts(config.labels),
      context
    );

    throwIfProviderRequestAborted(context);
    return volumes.map(mapHetznerVolumeToInstance);
  }

  private toHetznerLabelSelectorParts(labels?: Record<string, string>): string[] {
    if (!labels) return [];
    return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  }

  private async fetchPaginatedHetznerList(
    resource: 'servers' | 'volumes',
    baseParams: URLSearchParams,
    operation: 'listVMs' | 'listVolumes',
    handlePage: (payload: unknown) => number | undefined,
    labelParts: string[],
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    const seenPages = new Set<number>();
    let page = 1;

    for (let pageCount = 0; pageCount < DEFAULT_HETZNER_MAX_LIST_PAGES; pageCount += 1) {
      throwIfProviderRequestAborted(context);
      recordHetznerListPage(seenPages, page, operation);

      const url = buildHetznerListUrl(resource, baseParams, labelParts, page);
      const response = await providerFetch(
        this.name,
        url,
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
      const payload = await parseProviderJson(response, this.name, operation);
      throwIfProviderRequestAborted(context);
      const nextPage = handlePage(payload);
      if (nextPage === undefined) return;
      page = nextPage;
    }

    throw new ProviderError(
      this.name,
      undefined,
      `Hetzner ${operation} exceeded ${DEFAULT_HETZNER_MAX_LIST_PAGES} pages`,
      {
        category: 'invalid_config',
      }
    );
  }

  private validateRequestedVolumeSize(sizeGb: number): void {
    if (!Number.isInteger(sizeGb) || sizeGb < HETZNER_VOLUME_MIN_SIZE_GB) {
      throw new ProviderError(
        this.name,
        undefined,
        `Hetzner volume size must be an integer >= ${HETZNER_VOLUME_MIN_SIZE_GB}GB`,
        { category: 'invalid_config' }
      );
    }
    if (sizeGb > HETZNER_VOLUME_MAX_SIZE_GB) {
      throw new ProviderError(
        this.name,
        undefined,
        `Hetzner volume size must be <= ${HETZNER_VOLUME_MAX_SIZE_GB}GB`,
        { category: 'invalid_config' }
      );
    }
  }

  private async getCurrentVolumeSize(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<number> {
    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(this.name, 404, `Hetzner volume ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }
}
