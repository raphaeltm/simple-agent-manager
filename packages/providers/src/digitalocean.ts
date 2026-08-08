import type { VMSize } from '@simple-agent-manager/shared';
import {
  DEFAULT_DIGITALOCEAN_IMAGE,
  DEFAULT_DIGITALOCEAN_REGION,
} from '@simple-agent-manager/shared';

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
  ProviderErrorCategory,
  ProviderLogger,
  ProviderRequestContext,
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
} from './types';
import { noopProviderLogger, ProviderError } from './types';
import { parseProviderJson } from './validation';
import {
  type DigitalOceanDropletPayload,
  type DigitalOceanNetworkV4,
  validateDigitalOceanDropletResponse,
  validateDigitalOceanDropletsResponse,
} from './validation-digitalocean';

const DIGITALOCEAN_API_URL = 'https://api.digitalocean.com/v2';

export const DEFAULT_DIGITALOCEAN_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_DIGITALOCEAN_IP_POLL_TIMEOUT_MS = 20_000;
export const DEFAULT_DIGITALOCEAN_IP_POLL_INTERVAL_MS = 3_000;
export const DEFAULT_DIGITALOCEAN_ACTION_POLL_INTERVAL_MS = 1_000;
export const DEFAULT_DIGITALOCEAN_MAX_LIST_PAGES = 20;
const DIGITALOCEAN_LIST_PER_PAGE = 200;

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

const DIGITALOCEAN_LOCATION_META: Record<string, LocationMeta> = {
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

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 's-2vcpu-4gb',
    price: '~$24/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 80,
  },
  medium: {
    type: 's-4vcpu-8gb',
    price: '~$48/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 160,
  },
  large: {
    type: 's-8vcpu-16gb',
    price: '~$96/mo',
    vcpu: 8,
    ramGb: 16,
    storageGb: 320,
  },
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

/**
 * Classify a DigitalOcean API error into a normalized ProviderErrorCategory.
 *
 * DO error responses are `{ id: "<code>", message: "<message>", request_id }`. The
 * top-level `message` is surfaced by provider-fetch; classification uses the HTTP
 * status plus message heuristics.
 */
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

/**
 * Map DigitalOcean's droplet `status` onto a normalized VMStatus.
 * - `new`: provisioning
 * - `active`: powered on and running
 * - `off`: powered off
 * - `archive`: archived (treated as off — VMStatus has no terminated state)
 */
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

/** Extract the public IPv4 address from a droplet's `networks.v4[]` (empty until active). */
export function extractPublicIp(networks: DigitalOceanNetworkV4[]): string {
  const publicNet = networks.find((net) => net.type === 'public' && net.ip_address);
  return publicNet?.ip_address ?? '';
}

/** Sanitize a SAM node name into a valid DigitalOcean droplet name (lowercase alnum + hyphen, <=63 chars). */
function sanitizeDropletName(name: string): string {
  const host = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    // Strip AFTER truncating so a slice landing mid-hyphen can't leave a trailing '-'.
    .replace(/^-+|-+$/g, '');
  return host || 'sam-node';
}

/** DO `image` accepts a slug string or a numeric image id. */
function resolveImage(image: string): string | number {
  const trimmed = image.trim();
  return /^\d+$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed;
}

export class DigitalOceanProvider implements Provider {
  readonly name = 'digitalocean';
  readonly locations: readonly string[] = DIGITALOCEAN_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = DIGITALOCEAN_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;
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
          image: resolveImage(config.image || this.image),
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
