import type { VMSize } from '@simple-agent-manager/shared';
import { DEFAULT_VULTR_OS_NAME, DEFAULT_VULTR_REGION } from '@simple-agent-manager/shared';

import { kvTagsToLabels, labelsToKvTags } from './kv-tags';
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
  validateVultrInstanceResponse,
  validateVultrInstancesResponse,
  validateVultrOsResponse,
  type VultrInstancePayload,
  type VultrOsPayload,
} from './validation-vultr';
import {
  classifyVultrError,
  DEFAULT_VULTR_IP_POLL_INTERVAL_MS,
  DEFAULT_VULTR_IP_POLL_TIMEOUT_MS,
  DEFAULT_VULTR_REQUEST_TIMEOUT_MS,
  findVultrOs,
  mapVultrStatus,
  normalizeVultrIp,
  positiveVultrOption,
  sanitizeVultrHostname,
  toVultrBase64,
  VULTR_API_URL,
  VULTR_LIST_PER_PAGE,
  VULTR_LOCATION_META,
  VULTR_LOCATIONS,
  VULTR_MAX_LIST_PAGES,
  VULTR_SIZE_CONFIGS,
  type VultrProviderRuntimeOptions,
} from './vultr-metadata';
import { VULTR_VOLUME_CAPABILITIES, VultrVolumeClient } from './vultr-volumes';

export {
  classifyVultrError,
  DEFAULT_VULTR_IP_POLL_INTERVAL_MS,
  DEFAULT_VULTR_IP_POLL_TIMEOUT_MS,
  DEFAULT_VULTR_REQUEST_TIMEOUT_MS,
  findVultrOs,
  mapVultrStatus,
  VULTR_LOCATIONS,
  type VultrProviderRuntimeOptions,
} from './vultr-metadata';

export class VultrProvider implements Provider {
  readonly name = 'vultr';
  readonly locations: readonly string[] = VULTR_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = VULTR_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = VULTR_SIZE_CONFIGS;
  readonly volumeCapabilities: VolumeCapabilities = VULTR_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;

  private readonly apiToken: string;
  private readonly region: string;
  private readonly osName: string;
  private readonly requestTimeoutMs: number;
  private readonly ipPollTimeoutMs: number;
  private readonly ipPollIntervalMs: number;
  private readonly logger: ProviderLogger;
  private readonly volumeClient: VultrVolumeClient;
  private osIdCache?: number;

  constructor(apiToken: string, options?: VultrProviderRuntimeOptions) {
    this.apiToken = apiToken;
    this.region = options?.region || DEFAULT_VULTR_REGION;
    this.defaultLocation = this.region;
    this.osName = options?.osName || DEFAULT_VULTR_OS_NAME;
    this.requestTimeoutMs = positiveVultrOption(
      options?.requestTimeoutMs,
      DEFAULT_VULTR_REQUEST_TIMEOUT_MS
    );
    this.ipPollTimeoutMs = positiveVultrOption(
      options?.ipPollTimeoutMs,
      DEFAULT_VULTR_IP_POLL_TIMEOUT_MS
    );
    this.ipPollIntervalMs = positiveVultrOption(
      options?.ipPollIntervalMs,
      DEFAULT_VULTR_IP_POLL_INTERVAL_MS
    );
    this.logger = options?.logger ?? noopProviderLogger;
    this.volumeClient = new VultrVolumeClient(
      this.apiToken,
      (err) => this.mapProviderError(err),
      this.requestTimeoutMs
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
    const osId = await this.resolveOsId(config.image, context);
    throwIfProviderRequestAborted(context);

    const response = await this.vultrFetch(
      '/instances',
      {
        method: 'POST',
        body: JSON.stringify({
          region,
          plan: sizeConfig.type,
          os_id: osId,
          label: config.name,
          hostname: sanitizeVultrHostname(config.name),
          user_data: toVultrBase64(config.userData),
          tags: labelsToKvTags(config.labels || {}),
          backups: 'disabled',
          activation_email: false,
        }),
      },
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const data = validateVultrInstanceResponse(
      await parseProviderJson(response, this.name, 'createVM'),
      'createVM'
    );
    throwIfProviderRequestAborted(context);

    // Vultr allocates main_ip asynchronously (0.0.0.0 until ready). Best-effort short poll;
    // if it doesn't land in time, return empty ip — provisionNode tolerates it and the
    // control-plane heartbeat IP backfill self-heals on the VM agent's first heartbeat.
    const ip = await this.pollForIp(data.instance.id, data.instance.main_ip, context);
    throwIfProviderRequestAborted(context);
    return { ...this.mapInstance(data.instance), ip };
  }

  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    try {
      await this.vultrFetch(
        `/instances/${encodeURIComponent(id)}`,
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
    const instance = await this.getInstanceRaw(id, undefined, context);
    throwIfProviderRequestAborted(context);
    return instance ? this.mapInstance(instance) : null;
  }

  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const instances = await this.fetchAllInstances(context);
    throwIfProviderRequestAborted(context);
    let result = instances.map((instance) => this.mapInstance(instance));
    if (labels && Object.keys(labels).length > 0) {
      const entries = Object.entries(labels);
      result = result.filter((vm) => entries.every(([key, value]) => vm.labels[key] === value));
    }
    return result;
  }

  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    // Vultr has no graceful shutdown — halt is the only stop action.
    await this.instanceAction(id, 'halt', context);
  }

  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.instanceAction(id, 'start', context);
  }

  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    await this.vultrFetch('/account', undefined, undefined, context);
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

  private async resolveOsId(image?: string, context?: ProviderRequestContext): Promise<number> {
    throwIfProviderRequestAborted(context);
    // Explicit numeric os_id override
    if (image && /^\d+$/.test(image.trim())) {
      return Number.parseInt(image.trim(), 10);
    }
    const targetName = image || this.osName;
    if (!image && this.osIdCache !== undefined) return this.osIdCache;

    const list = await this.fetchAllOs(context);
    throwIfProviderRequestAborted(context);
    const match = findVultrOs(list, targetName);
    if (!match) {
      throw new ProviderError(this.name, undefined, `No Vultr OS found matching "${targetName}"`, {
        category: 'invalid_config',
      });
    }
    if (!image) this.osIdCache = match.id;
    return match.id;
  }

  private async fetchAllOs(context?: ProviderRequestContext): Promise<VultrOsPayload[]> {
    throwIfProviderRequestAborted(context);
    const all: VultrOsPayload[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < VULTR_MAX_LIST_PAGES; page += 1) {
      throwIfProviderRequestAborted(context);
      const params = new URLSearchParams({ per_page: String(VULTR_LIST_PER_PAGE) });
      if (cursor) params.set('cursor', cursor);
      const response = await this.vultrFetch(
        `/os?${params.toString()}`,
        undefined,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateVultrOsResponse(
        await parseProviderJson(response, this.name, 'resolveOsId'),
        'resolveOsId'
      );
      all.push(...data.os);
      if (!data.nextCursor) return all;
      cursor = data.nextCursor;
    }
    this.logger.warn('vultr.list_truncated', { resource: 'os', maxPages: VULTR_MAX_LIST_PAGES });
    return all;
  }

  private async fetchAllInstances(
    context?: ProviderRequestContext
  ): Promise<VultrInstancePayload[]> {
    throwIfProviderRequestAborted(context);
    const all: VultrInstancePayload[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < VULTR_MAX_LIST_PAGES; page += 1) {
      throwIfProviderRequestAborted(context);
      const params = new URLSearchParams({ per_page: String(VULTR_LIST_PER_PAGE) });
      if (cursor) params.set('cursor', cursor);
      const response = await this.vultrFetch(
        `/instances?${params.toString()}`,
        undefined,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateVultrInstancesResponse(
        await parseProviderJson(response, this.name, 'listVMs'),
        'listVMs'
      );
      all.push(...data.instances);
      if (!data.nextCursor) return all;
      cursor = data.nextCursor;
    }
    this.logger.warn('vultr.list_truncated', {
      resource: 'instances',
      maxPages: VULTR_MAX_LIST_PAGES,
    });
    return all;
  }

  private async getInstanceRaw(
    id: string,
    timeoutMs?: number,
    context?: ProviderRequestContext
  ): Promise<VultrInstancePayload | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await this.vultrFetch(
        `/instances/${encodeURIComponent(id)}`,
        undefined,
        timeoutMs,
        context
      );
      throwIfProviderRequestAborted(context);
      const data = validateVultrInstanceResponse(
        await parseProviderJson(response, this.name, 'getVM'),
        'getVM'
      );
      throwIfProviderRequestAborted(context);
      return data.instance;
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) return null;
      throw err;
    }
  }

  private async pollForIp(
    instanceId: string,
    initialIp: string,
    context?: ProviderRequestContext
  ): Promise<string> {
    throwIfProviderRequestAborted(context);
    const initial = normalizeVultrIp(initialIp);
    if (initial) return initial;

    // Hard-bound total wall time to ipPollTimeoutMs: cap both the inter-poll delay
    // and each poll GET to the remaining budget so a slow (but un-aborted) request
    // can't overshoot. Best-effort — heartbeat IP backfill is the durable fallback.
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (Date.now() < deadline) {
      await providerDelay(Math.min(this.ipPollIntervalMs, deadline - Date.now()), context);
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const instance = await this.getInstanceRaw(
          instanceId,
          Math.min(this.requestTimeoutMs, remaining),
          context
        );
        const ip = normalizeVultrIp(instance?.main_ip ?? '');
        if (ip) return ip;
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
        this.logger.warn('vultr.ip_poll_error', { instanceId });
      }
    }
    return '';
  }

  private async instanceAction(
    id: string,
    action: 'halt' | 'start',
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.vultrFetch(
      `/instances/${encodeURIComponent(id)}/${action}`,
      { method: 'POST' },
      undefined,
      context
    );
  }

  private mapInstance(instance: VultrInstancePayload): VMInstance {
    return {
      id: instance.id,
      name: instance.label || instance.id,
      ip: normalizeVultrIp(instance.main_ip),
      status: mapVultrStatus(instance.status, instance.power_status, instance.server_status),
      serverType: instance.plan,
      createdAt: instance.date_created,
      labels: kvTagsToLabels(instance.tags),
    };
  }

  private async vultrFetch(
    path: string,
    init?: RequestInit,
    timeoutMs: number = this.requestTimeoutMs,
    context?: ProviderRequestContext
  ): Promise<Response> {
    throwIfProviderRequestAborted(context);
    try {
      return await providerFetch(
        this.name,
        `${VULTR_API_URL}${path}`,
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
      category: classifyVultrError(err.statusCode, err.message),
    });
  }
}
