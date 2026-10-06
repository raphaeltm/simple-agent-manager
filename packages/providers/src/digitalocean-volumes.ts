import {
  DIGITALOCEAN_API_URL,
  DIGITALOCEAN_LIST_PER_PAGE,
  type DigitalOceanErrorMapper,
  type DigitalOceanVolumeClientOptions,
  mapDigitalOceanVolume,
  sanitizeDigitalOceanVolumeName,
  toDigitalOceanDropletId,
  validateDigitalOceanVolumeSize,
} from './digitalocean-metadata';
import { DIGITALOCEAN_VOLUME_NAME_TAG_KEY, labelsToDigitalOceanTags } from './digitalocean-tags';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  ProviderLogger,
  ProviderRequestContext,
  VolumeAttachmentConfig,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
} from './types';
import { ProviderError } from './types';
import { parseProviderJson } from './validation';
import {
  type DigitalOceanActionPayload,
  type DigitalOceanVolumePayload,
  validateDigitalOceanActionResponse,
  validateDigitalOceanVolumeResponse,
  validateDigitalOceanVolumesResponse,
} from './validation-digitalocean';

export type {
  DigitalOceanErrorMapper,
  DigitalOceanVolumeClientOptions,
} from './digitalocean-metadata';
export {
  DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS,
  DIGITALOCEAN_VOLUME_CAPABILITIES,
  DIGITALOCEAN_VOLUME_MAX_SIZE_GB,
  DIGITALOCEAN_VOLUME_MIN_SIZE_GB,
  sanitizeDigitalOceanVolumeName,
} from './digitalocean-metadata';

export class DigitalOceanVolumeClient {
  private readonly requestTimeoutMs: number;
  private readonly actionPollTimeoutMs: number;
  private readonly actionPollIntervalMs: number;
  private readonly maxListPages: number;
  private readonly logger?: ProviderLogger;

  constructor(
    private readonly apiToken: string,
    private readonly mapProviderError: DigitalOceanErrorMapper,
    options: DigitalOceanVolumeClientOptions
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.actionPollTimeoutMs = options.actionPollTimeoutMs;
    this.actionPollIntervalMs = options.actionPollIntervalMs;
    this.maxListPages = options.maxListPages;
    this.logger = options.logger;
  }

  async createVolume(
    config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    validateDigitalOceanVolumeSize(config.sizeGb);

    // DO volume names are lossy (lowercased/sanitized/truncated). Round-trip the EXACT
    // SAM name via a sam-name tag so getVolume/listVolumes stays faithful.
    const tags = labelsToDigitalOceanTags({
      [DIGITALOCEAN_VOLUME_NAME_TAG_KEY]: config.name,
      ...(config.labels ?? {}),
    });

    let response: Response;
    try {
      response = await this.doFetch(
        '/volumes',
        {
          method: 'POST',
          body: JSON.stringify({
            name: sanitizeDigitalOceanVolumeName(config.name),
            region: config.location,
            size_gigabytes: config.sizeGb,
            tags,
          }),
        },
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      throw this.mapProviderError(err);
    }

    throwIfProviderRequestAborted(context);
    const data = validateDigitalOceanVolumeResponse(
      await parseProviderJson(response, 'digitalocean', 'createVolume'),
      'createVolume'
    );
    throwIfProviderRequestAborted(context);
    return mapDigitalOceanVolume(data.volume);
  }

  async attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    const dropletId = toDigitalOceanDropletId(config.serverId);
    await this.runVolumeAction(
      config.volumeId,
      'attachVolume',
      {
        type: 'attach',
        droplet_id: dropletId,
        region: config.location,
      },
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        'digitalocean',
        404,
        `DigitalOcean volume ${config.volumeId} not found after attach`,
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
    const current = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    throwIfProviderRequestAborted(context);
    if (!current) return null; // Already gone — idempotent.

    // Detach from whatever droplet the volume is actually attached to (authoritative),
    // falling back to the caller-supplied serverId. If nothing is attached, it's a no-op.
    const attached = current.attachedServerId ?? config.serverId;
    if (!attached) return current;

    await this.runVolumeAction(
      config.volumeId,
      'detachVolume',
      {
        type: 'detach',
        droplet_id: toDigitalOceanDropletId(attached),
        region: config.location,
      },
      context
    );

    throwIfProviderRequestAborted(context);
    return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
  }

  async resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    validateDigitalOceanVolumeSize(config.sizeGb);
    const currentSizeGb =
      config.currentSizeGb ?? (await this.getCurrentVolumeSize(config, context));
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `Cannot shrink DigitalOcean volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' }
      );
    }

    await this.runVolumeAction(
      config.volumeId,
      'resizeVolume',
      {
        type: 'resize',
        size_gigabytes: config.sizeGb,
        region: config.location,
      },
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        'digitalocean',
        404,
        `DigitalOcean volume ${config.volumeId} not found after resize`,
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
      await this.doFetch(
        `/volumes/${encodeURIComponent(config.volumeId)}`,
        { method: 'DELETE' },
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent
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
      const response = await this.doFetch(
        `/volumes/${encodeURIComponent(config.volumeId)}`,
        undefined,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateDigitalOceanVolumeResponse(
        await parseProviderJson(response, 'digitalocean', 'getVolume'),
        'getVolume'
      );
      throwIfProviderRequestAborted(context);
      return mapDigitalOceanVolume(data.volume);
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
    const volumes = await this.fetchAllVolumes(config.location, context);
    throwIfProviderRequestAborted(context);
    let mapped = volumes.map((volume) => mapDigitalOceanVolume(volume));

    if (config.labels && Object.keys(config.labels).length > 0) {
      const entries = Object.entries(config.labels);
      mapped = mapped.filter((volume) =>
        entries.every(([key, value]) => volume.labels[key] === value)
      );
    }
    return mapped;
  }

  private async fetchAllVolumes(
    location: string,
    context?: ProviderRequestContext
  ): Promise<DigitalOceanVolumePayload[]> {
    throwIfProviderRequestAborted(context);
    const all: DigitalOceanVolumePayload[] = [];
    for (let page = 1; page <= this.maxListPages; page += 1) {
      throwIfProviderRequestAborted(context);
      const params = new URLSearchParams({
        per_page: String(DIGITALOCEAN_LIST_PER_PAGE),
        page: String(page),
        region: location,
      });
      const response = await this.doFetch(
        `/volumes?${params.toString()}`,
        undefined,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateDigitalOceanVolumesResponse(
        await parseProviderJson(response, 'digitalocean', 'listVolumes'),
        'listVolumes'
      );
      all.push(...data.volumes);
      if (!data.hasNextPage) return all;
    }
    this.logger?.warn('digitalocean.list_truncated', {
      resource: 'volumes',
      maxPages: this.maxListPages,
    });
    return all;
  }

  /** Issue a volume action and poll it to completion within the configured budget. */
  private async runVolumeAction(
    volumeId: string,
    operation: string,
    body: Record<string, unknown>,
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    const response = await this.doFetch(
      `/volumes/${encodeURIComponent(volumeId)}/actions`,
      {
        method: 'POST',
        body: JSON.stringify(body),
      },
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const data = validateDigitalOceanActionResponse(
      await parseProviderJson(response, 'digitalocean', operation),
      operation
    );
    throwIfProviderRequestAborted(context);
    await this.pollAction(data.action, operation, context);
  }

  /** Poll a DigitalOcean async action to `completed`, hard-bounded by actionPollTimeoutMs. */
  private async pollAction(
    action: DigitalOceanActionPayload,
    operation: string,
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    if (action.status === 'completed') return;
    if (action.status === 'errored') {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `DigitalOcean ${operation} action ${action.id} errored`,
        {
          category: 'transient_capacity',
        }
      );
    }

    const deadline = Date.now() + this.actionPollTimeoutMs;
    while (Date.now() < deadline) {
      await providerDelay(Math.min(this.actionPollIntervalMs, deadline - Date.now()), context);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const current = await this.getAction(
        action.id,
        Math.min(this.requestTimeoutMs, remaining),
        context
      );
      if (current.status === 'completed') return;
      if (current.status === 'errored') {
        throw new ProviderError(
          'digitalocean',
          undefined,
          `DigitalOcean ${operation} action ${action.id} errored`,
          {
            category: 'transient_capacity',
          }
        );
      }
    }
    throw new ProviderError(
      'digitalocean',
      undefined,
      `DigitalOcean ${operation} action ${action.id} did not complete within ${this.actionPollTimeoutMs}ms`,
      { category: 'transient_capacity' }
    );
  }

  private async getAction(
    actionId: number,
    timeoutMs: number,
    context?: ProviderRequestContext
  ): Promise<DigitalOceanActionPayload> {
    throwIfProviderRequestAborted(context);
    const response = await this.doFetch(`/actions/${actionId}`, undefined, timeoutMs, context);
    throwIfProviderRequestAborted(context);
    const data = validateDigitalOceanActionResponse(
      await parseProviderJson(response, 'digitalocean', 'pollAction'),
      'pollAction'
    );
    throwIfProviderRequestAborted(context);
    return data.action;
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
      throw new ProviderError(
        'digitalocean',
        404,
        `DigitalOcean volume ${config.volumeId} not found`,
        {
          category: 'invalid_config',
        }
      );
    }
    return volume.sizeGb;
  }

  private async doFetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number = this.requestTimeoutMs,
    context?: ProviderRequestContext
  ): Promise<Response> {
    throwIfProviderRequestAborted(context);
    try {
      return await providerFetch(
        'digitalocean',
        `${DIGITALOCEAN_API_URL}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
          },
        },
        timeoutMs,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      throw this.mapProviderError(err);
    }
  }
}
