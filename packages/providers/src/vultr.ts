import type { VMSize } from '@simple-agent-manager/shared';
import { DEFAULT_VULTR_OS_NAME, DEFAULT_VULTR_REGION } from '@simple-agent-manager/shared';

import { kvTagsToLabels, labelsToKvTags } from './kv-tags';
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
import { VULTR_VOLUME_CAPABILITIES, VultrVolumeClient } from './vultr-volumes';

const VULTR_API_URL = 'https://api.vultr.com/v2';

export const DEFAULT_VULTR_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_VULTR_IP_POLL_TIMEOUT_MS = 15_000;
export const DEFAULT_VULTR_IP_POLL_INTERVAL_MS = 3_000;
const VULTR_LIST_PER_PAGE = 100;
const VULTR_MAX_LIST_PAGES = 50;
const VULTR_UNASSIGNED_IP = '0.0.0.0';

export const VULTR_LOCATIONS = [
  'fra', 'ams', 'lhr', 'ewr', 'ord', 'lax', 'nrt', 'sgp', 'syd',
] as const;

const VULTR_LOCATION_META: Record<string, LocationMeta> = {
  fra: { name: 'Frankfurt', country: 'DE' },
  ams: { name: 'Amsterdam', country: 'NL' },
  lhr: { name: 'London', country: 'GB' },
  ewr: { name: 'New Jersey', country: 'US' },
  ord: { name: 'Chicago', country: 'US' },
  lax: { name: 'Los Angeles', country: 'US' },
  nrt: { name: 'Tokyo', country: 'JP' },
  sgp: { name: 'Singapore', country: 'SG' },
  syd: { name: 'Sydney', country: 'AU' },
};

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'vc2-2c-4gb',
    price: '~$20/mo',
    vcpu: 2,
    ramGb: 4,
    storageGb: 80,
  },
  medium: {
    type: 'vc2-4c-8gb',
    price: '~$40/mo',
    vcpu: 4,
    ramGb: 8,
    storageGb: 160,
  },
  large: {
    type: 'vc2-6c-16gb',
    price: '~$80/mo',
    vcpu: 6,
    ramGb: 16,
    storageGb: 320,
  },
};

export interface VultrProviderRuntimeOptions {
  region?: string;
  osName?: string;
  requestTimeoutMs?: number;
  ipPollTimeoutMs?: number;
  ipPollIntervalMs?: number;
  logger?: ProviderLogger;
}

/**
 * Classify a Vultr API error into a normalized ProviderErrorCategory.
 *
 * Vultr error responses are `{ "error": "<message>", "status": <int> }` — the top-level
 * `error` is a plain STRING (no structured code), so classification uses the HTTP status
 * plus message heuristics rather than a providerCode.
 */
export function classifyVultrError(
  statusCode: number | undefined,
  message: string,
): ProviderErrorCategory {
  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'transient_capacity';
  if (/not available|no capacity|out of stock|sold out|no available|temporarily unavailable/i.test(message)) {
    return 'transient_capacity';
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 422) return 'invalid_config';
  return 'unknown';
}

/**
 * Combine Vultr's three status fields into a normalized VMStatus.
 * - `status`: pending | active | suspended | resizing
 * - `power_status`: running | stopped
 * - `server_status`: none | locked | installingbooting | ok
 */
export function mapVultrStatus(
  status: string,
  powerStatus: string,
  serverStatus: string,
): VMStatus {
  if (status === 'pending' || status === 'installing') return 'initializing';
  if (status === 'resizing') return 'starting';
  if (status === 'suspended') return 'off';
  if (status === 'active') {
    if (powerStatus === 'stopped') return 'off';
    if (powerStatus === 'running') {
      return serverStatus === 'ok' ? 'running' : 'starting';
    }
    return 'initializing';
  }
  return 'initializing';
}

/** Normalize Vultr's `main_ip`: the placeholder `0.0.0.0` means "not allocated yet". */
function normalizeVultrIp(ip: string): string {
  return !ip || ip === VULTR_UNASSIGNED_IP ? '' : ip;
}

/** Sanitize a SAM node name into a valid Vultr hostname (lowercase alnum + hyphen, <=63 chars). */
function sanitizeHostname(name: string): string {
  const host = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 63)
    // Strip AFTER truncating so a slice landing mid-hyphen can't leave a trailing '-'.
    .replace(/^-+|-+$/g, '');
  return host || 'sam-node';
}

/** Workers-safe base64 of a UTF-8 string (Vultr requires base64-encoded user_data). */
function toBase64(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/** Find the OS whose name matches `targetName` (exact first, then all-token-subset match). */
export function findVultrOs(list: VultrOsPayload[], targetName: string): VultrOsPayload | undefined {
  const lower = targetName.toLowerCase();
  const exact = list.find((os) => os.name.toLowerCase() === lower);
  if (exact) return exact;
  const tokens = lower.split(/\s+/).filter((token) => token.length > 1);
  return list.find((os) => {
    const name = os.name.toLowerCase();
    return tokens.every((token) => name.includes(token));
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VultrProvider implements Provider {
  readonly name = 'vultr';
  readonly locations: readonly string[] = VULTR_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = VULTR_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;
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
    this.requestTimeoutMs = positiveOr(options?.requestTimeoutMs, DEFAULT_VULTR_REQUEST_TIMEOUT_MS);
    this.ipPollTimeoutMs = positiveOr(options?.ipPollTimeoutMs, DEFAULT_VULTR_IP_POLL_TIMEOUT_MS);
    this.ipPollIntervalMs = positiveOr(options?.ipPollIntervalMs, DEFAULT_VULTR_IP_POLL_INTERVAL_MS);
    this.logger = options?.logger ?? noopProviderLogger;
    this.volumeClient = new VultrVolumeClient(
      this.apiToken,
      (err) => this.mapProviderError(err),
      this.requestTimeoutMs,
    );
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`, {
        category: 'invalid_config',
      });
    }
    const region = config.location || this.region;
    const osId = await this.resolveOsId(config.image);

    const response = await this.vultrFetch('/instances', {
      method: 'POST',
      body: JSON.stringify({
        region,
        plan: sizeConfig.type,
        os_id: osId,
        label: config.name,
        hostname: sanitizeHostname(config.name),
        user_data: toBase64(config.userData),
        tags: labelsToKvTags(config.labels || {}),
        backups: 'disabled',
        activation_email: false,
      }),
    });

    const data = validateVultrInstanceResponse(
      await parseProviderJson(response, this.name, 'createVM'),
      'createVM',
    );

    // Vultr allocates main_ip asynchronously (0.0.0.0 until ready). Best-effort short poll;
    // if it doesn't land in time, return empty ip — provisionNode tolerates it and the
    // control-plane heartbeat IP backfill self-heals on the VM agent's first heartbeat.
    const ip = await this.pollForIp(data.instance.id, data.instance.main_ip);
    return { ...this.mapInstance(data.instance), ip };
  }

  async deleteVM(id: string): Promise<void> {
    try {
      await this.vultrFetch(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) return; // Idempotent
      throw err;
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    const instance = await this.getInstanceRaw(id);
    return instance ? this.mapInstance(instance) : null;
  }

  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const instances = await this.fetchAllInstances();
    let result = instances.map((instance) => this.mapInstance(instance));
    if (labels && Object.keys(labels).length > 0) {
      const entries = Object.entries(labels);
      result = result.filter((vm) => entries.every(([key, value]) => vm.labels[key] === value));
    }
    return result;
  }

  async powerOff(id: string): Promise<void> {
    // Vultr has no graceful shutdown — halt is the only stop action.
    await this.instanceAction(id, 'halt');
  }

  async powerOn(id: string): Promise<void> {
    await this.instanceAction(id, 'start');
  }

  async validateToken(): Promise<boolean> {
    await this.vultrFetch('/account');
    return true;
  }

  createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    return this.volumeClient.createVolume(config);
  }

  attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    return this.volumeClient.attachVolume(config);
  }

  detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    return this.volumeClient.detachVolume(config);
  }

  resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance> {
    return this.volumeClient.resizeVolume(config);
  }

  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    await this.volumeClient.deleteVolume(config);
  }

  getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    return this.volumeClient.getVolume(config);
  }

  listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    return this.volumeClient.listVolumes(config);
  }

  private async resolveOsId(image?: string): Promise<number> {
    // Explicit numeric os_id override
    if (image && /^\d+$/.test(image.trim())) {
      return Number.parseInt(image.trim(), 10);
    }
    const targetName = image || this.osName;
    if (!image && this.osIdCache !== undefined) return this.osIdCache;

    const list = await this.fetchAllOs();
    const match = findVultrOs(list, targetName);
    if (!match) {
      throw new ProviderError(
        this.name,
        undefined,
        `No Vultr OS found matching "${targetName}"`,
        { category: 'invalid_config' },
      );
    }
    if (!image) this.osIdCache = match.id;
    return match.id;
  }

  private async fetchAllOs(): Promise<VultrOsPayload[]> {
    const all: VultrOsPayload[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < VULTR_MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams({ per_page: String(VULTR_LIST_PER_PAGE) });
      if (cursor) params.set('cursor', cursor);
      const response = await this.vultrFetch(`/os?${params.toString()}`);
      const data = validateVultrOsResponse(
        await parseProviderJson(response, this.name, 'resolveOsId'),
        'resolveOsId',
      );
      all.push(...data.os);
      if (!data.nextCursor) return all;
      cursor = data.nextCursor;
    }
    this.logger.warn('vultr.list_truncated', { resource: 'os', maxPages: VULTR_MAX_LIST_PAGES });
    return all;
  }

  private async fetchAllInstances(): Promise<VultrInstancePayload[]> {
    const all: VultrInstancePayload[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < VULTR_MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams({ per_page: String(VULTR_LIST_PER_PAGE) });
      if (cursor) params.set('cursor', cursor);
      const response = await this.vultrFetch(`/instances?${params.toString()}`);
      const data = validateVultrInstancesResponse(
        await parseProviderJson(response, this.name, 'listVMs'),
        'listVMs',
      );
      all.push(...data.instances);
      if (!data.nextCursor) return all;
      cursor = data.nextCursor;
    }
    this.logger.warn('vultr.list_truncated', { resource: 'instances', maxPages: VULTR_MAX_LIST_PAGES });
    return all;
  }

  private async getInstanceRaw(id: string, timeoutMs?: number): Promise<VultrInstancePayload | null> {
    try {
      const response = await this.vultrFetch(`/instances/${encodeURIComponent(id)}`, undefined, timeoutMs);
      const data = validateVultrInstanceResponse(
        await parseProviderJson(response, this.name, 'getVM'),
        'getVM',
      );
      return data.instance;
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) return null;
      throw err;
    }
  }

  private async pollForIp(instanceId: string, initialIp: string): Promise<string> {
    const initial = normalizeVultrIp(initialIp);
    if (initial) return initial;

    // Hard-bound total wall time to ipPollTimeoutMs: cap both the inter-poll delay
    // and each poll GET to the remaining budget so a slow (but un-aborted) request
    // can't overshoot. Best-effort — heartbeat IP backfill is the durable fallback.
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (Date.now() < deadline) {
      await delay(Math.min(this.ipPollIntervalMs, deadline - Date.now()));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      try {
        const instance = await this.getInstanceRaw(instanceId, Math.min(this.requestTimeoutMs, remaining));
        const ip = normalizeVultrIp(instance?.main_ip ?? '');
        if (ip) return ip;
      } catch {
        this.logger.warn('vultr.ip_poll_error', { instanceId });
      }
    }
    return '';
  }

  private async instanceAction(id: string, action: 'halt' | 'start'): Promise<void> {
    await this.vultrFetch(`/instances/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
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
  ): Promise<Response> {
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
      );
    } catch (err) {
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

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
