import type { VMSize } from '@simple-agent-manager/shared';
import {
  DEFAULT_DIGITALOCEAN_IMAGE,
  DEFAULT_DIGITALOCEAN_REGION,
} from '@simple-agent-manager/shared';

import {
  classifyDigitalOceanError,
  DEFAULT_DIGITALOCEAN_ACTION_POLL_INTERVAL_MS,
  DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS,
  DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS,
  DEFAULT_DIGITALOCEAN_MAX_LIST_PAGES,
  DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS,
  DIGITALOCEAN_API_URL,
  DIGITALOCEAN_LIST_PER_PAGE,
  DIGITALOCEAN_LOCATION_META,
  DIGITALOCEAN_LOCATIONS,
  DIGITALOCEAN_SIZE_CONFIGS,
  type DigitalOceanProviderRuntimeOptions,
  extractPublicIp,
  mapDigitalOceanStatus,
  resolveDigitalOceanImage,
  sanitizeDropletName,
} from './digitalocean-metadata';
import { digitalOceanTagsToLabels, labelsToDigitalOceanTags } from './digitalocean-tags';
import {
  DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS,
  DIGITALOCEAN_VOLUME_CAPABILITIES,
  DigitalOceanVolumeClient,
} from './digitalocean-volumes';
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
  VolumeCapabilities,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
} from './types';
import { noopProviderLogger, ProviderError } from './types';
import { parseProviderJson } from './validation';
import {
  type DigitalOceanDropletPayload,
  validateDigitalOceanDropletResponse,
  validateDigitalOceanDropletsResponse,
} from './validation-digitalocean';

export type { DigitalOceanProviderRuntimeOptions } from './digitalocean-metadata';
export {
  classifyDigitalOceanError,
  DEFAULT_DIGITALOCEAN_ACTION_POLL_INTERVAL_MS,
  DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS,
  DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS,
  DEFAULT_DIGITALOCEAN_MAX_LIST_PAGES,
  DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS,
  DIGITALOCEAN_LOCATIONS,
  extractPublicIp,
  mapDigitalOceanStatus,
} from './digitalocean-metadata';

export class DigitalOceanProvider implements Provider {
  readonly name = 'digitalocean';
  readonly locations: readonly string[] = DIGITALOCEAN_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = DIGITALOCEAN_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = DIGITALOCEAN_SIZE_CONFIGS;
  readonly volumeCapabilities: VolumeCapabilities = DIGITALOCEAN_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;

  private readonly apiToken: string;
  private readonly region: string;
  private readonly image: string;
  private readonly requestTimeoutMs: number;
  private readonly ipPollTimeoutMs: number;
  private readonly ipPollIntervalMs: number;
  private readonly maxListPages: number;
  private readonly logger: ProviderLogger;
  private readonly volumeClient: DigitalOceanVolumeClient;

  constructor(apiToken: string, options?: DigitalOceanProviderRuntimeOptions) {
    this.apiToken = apiToken;
    this.region = options?.region || DEFAULT_DIGITALOCEAN_REGION;
    this.defaultLocation = this.region;
    this.image = options?.image || DEFAULT_DIGITALOCEAN_IMAGE;
    this.requestTimeoutMs = positiveOr(
      options?.requestTimeoutMs,
      DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS
    );
    this.ipPollTimeoutMs = positiveOr(
      options?.ipPollTimeoutMs,
      DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS
    );
    this.ipPollIntervalMs = positiveOr(
      options?.ipPollIntervalMs,
      DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS
    );
    this.maxListPages = Math.floor(
      positiveOr(options?.maxListPages, DEFAULT_DIGITALOCEAN_MAX_LIST_PAGES)
    );
    this.logger = options?.logger ?? noopProviderLogger;
    this.volumeClient = new DigitalOceanVolumeClient(
      this.apiToken,
      (err) => this.mapProviderError(err),
      {
        requestTimeoutMs: this.requestTimeoutMs,
        actionPollTimeoutMs: positiveOr(
          options?.actionPollTimeoutMs,
          DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS
        ),
        actionPollIntervalMs: positiveOr(
          options?.actionPollIntervalMs,
          DEFAULT_DIGITALOCEAN_ACTION_POLL_INTERVAL_MS
        ),
        maxListPages: this.maxListPages,
        logger: this.logger,
      }
    );
  }

  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`, {
        category: 'invalid_config',
      });
    }
    const region = config.location || this.region;

    const response = await this.doFetch(
      '/droplets',
      {
        method: 'POST',
        body: JSON.stringify({
          name: sanitizeDropletName(config.name),
          region,
          size: sizeConfig.type,
          image: resolveDigitalOceanImage(config.image || this.image),
          // DigitalOcean user_data is PLAIN TEXT (max 64 KiB) — no base64 needed.
          user_data: config.userData,
          tags: labelsToDigitalOceanTags(config.labels || {}),
          backups: false,
          ipv6: false,
          monitoring: false,
        }),
      },
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const data = validateDigitalOceanDropletResponse(
      await parseProviderJson(response, this.name, 'createVM'),
      'createVM'
    );

    // The public IPv4 is assigned asynchronously (networks.v4 is empty until active).
    // Best-effort short poll; if it doesn't land in time, return empty ip — provisionNode
    // tolerates it and the heartbeat IP backfill self-heals on first heartbeat.
    const ip = await this.pollForIp(
      String(data.droplet.id),
      extractPublicIp(data.droplet.networks_v4),
      context
    );
    throwIfProviderRequestAborted(context);
    return { ...this.mapDroplet(data.droplet), ip };
  }

  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    try {
      await this.doFetch(
        `/droplets/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) return; // Idempotent
      throw err;
    }
  }

  async getVM(id: string, context?: ProviderRequestContext): Promise<VMInstance | null> {
    throwIfProviderRequestAborted(context);
    const droplet = await this.getDropletRaw(id, undefined, context);
    throwIfProviderRequestAborted(context);
    return droplet ? this.mapDroplet(droplet) : null;
  }

  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const droplets = await this.fetchAllDroplets(context);
    throwIfProviderRequestAborted(context);
    let result = droplets.map((droplet) => this.mapDroplet(droplet));
    if (labels && Object.keys(labels).length > 0) {
      const entries = Object.entries(labels);
      result = result.filter((vm) => entries.every(([key, value]) => vm.labels[key] === value));
    }
    return result;
  }

  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    // Hard power-off — matches Hetzner/Vultr semantics (SAM does not await async completion).
    await this.dropletAction(id, 'power_off', context);
  }

  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.dropletAction(id, 'power_on', context);
  }

  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    await this.doFetch('/account', undefined, undefined, context);
    throwIfProviderRequestAborted(context);
    return true;
  }

  createVolume(config: VolumeConfig, context?: ProviderRequestContext): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.createVolume(config, context);
  }

  attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.attachVolume(config, context);
  }

  detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.detachVolume(config, context);
  }

  resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.resizeVolume(config, context);
  }

  async deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.volumeClient.deleteVolume(config, context);
  }

  getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.getVolume(config, context);
  }

  listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    return this.volumeClient.listVolumes(config, context);
  }

  private async fetchAllDroplets(
    context?: ProviderRequestContext
  ): Promise<DigitalOceanDropletPayload[]> {
    throwIfProviderRequestAborted(context);
    const all: DigitalOceanDropletPayload[] = [];
    for (let page = 1; page <= this.maxListPages; page += 1) {
      throwIfProviderRequestAborted(context);
      const params = new URLSearchParams({
        per_page: String(DIGITALOCEAN_LIST_PER_PAGE),
        page: String(page),
      });
      const response = await this.doFetch(
        `/droplets?${params.toString()}`,
        undefined,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateDigitalOceanDropletsResponse(
        await parseProviderJson(response, this.name, 'listVMs'),
        'listVMs'
      );
      all.push(...data.droplets);
      if (!data.hasNextPage) return all;
    }
    this.logger.warn('digitalocean.list_truncated', {
      resource: 'droplets',
      maxPages: this.maxListPages,
    });
    return all;
  }

  private async getDropletRaw(
    id: string,
    timeoutMs?: number,
    context?: ProviderRequestContext
  ): Promise<DigitalOceanDropletPayload | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await this.doFetch(
        `/droplets/${encodeURIComponent(id)}`,
        undefined,
        timeoutMs,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateDigitalOceanDropletResponse(
        await parseProviderJson(response, this.name, 'getVM'),
        'getVM'
      );
      return data.droplet;
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) return null;
      throw err;
    }
  }

  private async pollForIp(
    dropletId: string,
    initialIp: string,
    context?: ProviderRequestContext
  ): Promise<string> {
    throwIfProviderRequestAborted(context);
    if (initialIp) return initialIp;

    // Hard-bound total wall time to ipPollTimeoutMs: cap both the inter-poll delay and
    // each poll GET to the remaining budget so a slow (but un-aborted) request can't
    // overshoot. Best-effort — heartbeat IP backfill is the durable fallback.
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (Date.now() < deadline) {
      await providerDelay(Math.min(this.ipPollIntervalMs, deadline - Date.now()), context);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const droplet = await this.getDropletRaw(
          dropletId,
          Math.min(this.requestTimeoutMs, remaining),
          context
        );
        const ip = extractPublicIp(droplet?.networks_v4 ?? []);
        if (ip) return ip;
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
        this.logger.warn('digitalocean.ip_poll_error', { dropletId });
      }
    }
    return '';
  }

  private async dropletAction(
    id: string,
    type: 'power_off' | 'power_on',
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.doFetch(
      `/droplets/${encodeURIComponent(id)}/actions`,
      {
        method: 'POST',
        body: JSON.stringify({ type }),
      },
      undefined,
      context
    );
  }

  private mapDroplet(droplet: DigitalOceanDropletPayload): VMInstance {
    return {
      id: String(droplet.id),
      name: droplet.name || String(droplet.id),
      ip: extractPublicIp(droplet.networks_v4),
      status: mapDigitalOceanStatus(droplet.status),
      serverType: droplet.size_slug,
      createdAt: droplet.created_at,
      labels: digitalOceanTagsToLabels(droplet.tags),
    };
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
        this.name,
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

  private mapProviderError(err: unknown): unknown {
    if (!(err instanceof ProviderError)) return err;
    return new ProviderError(this.name, err.statusCode, err.message, {
      cause: err,
      providerCode: err.providerCode,
      category: classifyDigitalOceanError(err.statusCode, err.message),
    });
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
