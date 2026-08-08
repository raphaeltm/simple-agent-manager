import type { VMSize } from '@simple-agent-manager/shared';

import {
  getTimeoutMs,
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
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
import {
  noopProviderLogger,
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import {
  assertUpCloudVolumeSize,
  classifyUpCloudError,
  isUpCloudNotFound,
  matchesUpCloudLabels,
  publicUpCloudIPv4,
  sanitizeUpCloudHostname,
  toUpCloudLabels,
  toUpCloudVM,
  toUpCloudVolume,
  upCloudBasicAuth,
  upCloudDevicePath,
} from './upcloud-utils';
import { parseProviderJson } from './validation';
import {
  type UpCloudServer,
  validateUpCloudAccountResponse,
  validateUpCloudPlansResponse,
  validateUpCloudServerResponse,
  validateUpCloudServersResponse,
  validateUpCloudStorageResponse,
  validateUpCloudStoragesResponse,
  validateUpCloudZonesResponse,
} from './validation-upcloud';

export const UPCLOUD_API_URL = 'https://api.upcloud.com/1.3';
export const DEFAULT_UPCLOUD_ZONE = 'de-fra1';
export const DEFAULT_UPCLOUD_IMAGE_TITLE = 'Ubuntu Server 24.04 LTS';
export const DEFAULT_UPCLOUD_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_UPCLOUD_IP_POLL_TIMEOUT_MS = 60_000;
export const DEFAULT_UPCLOUD_IP_POLL_INTERVAL_MS = 2_000;
export const DEFAULT_UPCLOUD_STOP_TIMEOUT_SECONDS = 60;
export const UPCLOUD_VOLUME_MIN_SIZE_GB = 1;
export const UPCLOUD_VOLUME_MAX_SIZE_GB = 4096;
const ROOT_DISK_SIZE_GB: Record<VMSize, number> = { small: 50, medium: 80, large: 160 };
const noLogger: ProviderLogger = noopProviderLogger;

export const UPCLOUD_LOCATIONS = [
  'de-fra1',
  'fi-hel1',
  'fi-hel2',
  'nl-ams1',
  'uk-lon1',
  'us-chi1',
  'us-nyc1',
  'us-sjo1',
  'sg-sin1',
  'au-syd1',
] as const;
const locationMetadata = {
  'de-fra1': { name: 'Frankfurt', country: 'DE' },
  'fi-hel1': { name: 'Helsinki 1', country: 'FI' },
  'fi-hel2': { name: 'Helsinki 2', country: 'FI' },
  'nl-ams1': { name: 'Amsterdam', country: 'NL' },
  'uk-lon1': { name: 'London', country: 'GB' },
  'us-chi1': { name: 'Chicago', country: 'US' },
  'us-nyc1': { name: 'New York', country: 'US' },
  'us-sjo1': { name: 'San Jose', country: 'US' },
  'sg-sin1': { name: 'Singapore', country: 'SG' },
  'au-syd1': { name: 'Sydney', country: 'AU' },
} as const;
const sizes: Record<VMSize, SizeConfig> = {
  small: { type: '2xCPU-4GB', price: 'provider-priced', vcpu: 2, ramGb: 4, storageGb: 50 },
  medium: { type: '4xCPU-8GB', price: 'provider-priced', vcpu: 4, ramGb: 8, storageGb: 80 },
  large: { type: '8xCPU-16GB', price: 'provider-priced', vcpu: 8, ramGb: 16, storageGb: 160 },
};
export const UPCLOUD_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: UPCLOUD_VOLUME_MIN_SIZE_GB,
  maxSizeGb: UPCLOUD_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  maxAttachedVolumesPerServer: 16,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'UpCloud storages attach only to servers in the same zone.',
    'Virtio device paths are best-effort; discover by filesystem UUID on the node.',
    'Resize is grow-only and may require the attached server to be stopped.',
  ],
};

export interface UpCloudProviderRuntimeOptions {
  apiUrl?: string;
  zone?: string;
  imageTitle?: string;
  requestTimeoutMs?: number;
  ipPollTimeoutMs?: number;
  ipPollIntervalMs?: number;
  stopTimeoutSeconds?: number;
  logger?: ProviderLogger;
}
export class UpCloudProvider implements Provider {
  readonly name = 'upcloud';
  readonly locations = UPCLOUD_LOCATIONS;
  readonly locationMetadata = locationMetadata;
  readonly sizes = sizes;
  readonly defaultLocation: string;
  readonly volumeCapabilities = UPCLOUD_VOLUME_CAPABILITIES;
  private readonly auth: string;
  private readonly apiUrl: string;
  private readonly imageTitle: string;
  private readonly requestTimeoutMs: number;
  private readonly ipPollTimeoutMs: number;
  private readonly ipPollIntervalMs: number;
  private readonly stopTimeoutSeconds: number;
  private readonly logger: ProviderLogger;
  private templateId?: string;
  private planNames?: Set<string>;
  private zoneNames?: Set<string>;
  constructor(username: string, password: string, options: UpCloudProviderRuntimeOptions = {}) {
    if (!username || !password)
      throw new ProviderError('upcloud', 401, 'UpCloud username and password are required', {
        category: 'auth_error',
      });
    this.auth = upCloudBasicAuth(username, password);
    this.apiUrl = options.apiUrl ?? UPCLOUD_API_URL;
    this.defaultLocation = options.zone ?? DEFAULT_UPCLOUD_ZONE;
    this.imageTitle = options.imageTitle ?? DEFAULT_UPCLOUD_IMAGE_TITLE;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_UPCLOUD_REQUEST_TIMEOUT_MS;
    this.ipPollTimeoutMs = options.ipPollTimeoutMs ?? DEFAULT_UPCLOUD_IP_POLL_TIMEOUT_MS;
    this.ipPollIntervalMs = options.ipPollIntervalMs ?? DEFAULT_UPCLOUD_IP_POLL_INTERVAL_MS;
    this.stopTimeoutSeconds = options.stopTimeoutSeconds ?? DEFAULT_UPCLOUD_STOP_TIMEOUT_SECONDS;
    this.logger = options.logger ?? noLogger;
  }
  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    await this.assertZoneAvailable(config.location, context);
    await this.assertPlanAvailable(this.sizes[config.size].type, context);
    const template = config.image ?? (await this.resolveTemplate(context));
    const body = {
      server: {
        zone: config.location,
        title: config.name,
        hostname: sanitizeUpCloudHostname(config.name),
        plan: this.sizes[config.size].type,
        user_data: config.userData,
        metadata: 'yes',
        labels: { label: toUpCloudLabels(config.labels) },
        storage_devices: {
          storage_device: [
            {
              action: 'clone',
              storage: template,
              title: `${config.name} root`,
              size: ROOT_DISK_SIZE_GB[config.size],
              tier: 'maxiops',
              encrypted: 'yes',
            },
          ],
        },
        networking: {
          interfaces: {
            interface: [
              { type: 'public', ip_addresses: { ip_address: [{ family: 'IPv4' }] } },
              { type: 'utility', ip_addresses: { ip_address: [{ family: 'IPv4' }] } },
              { type: 'public', ip_addresses: { ip_address: [{ family: 'IPv6' }] } },
            ],
          },
        },
      },
    };
    const response = await this.request(
      '/server',
      { method: 'POST', body: JSON.stringify(body) },
      context
    );
    let server = validateUpCloudServerResponse(
      await parseProviderJson(response, 'upcloud', 'createVM'),
      'createVM'
    );
    server = await this.pollForIp(server, context);
    return toUpCloudVM(server);
  }
  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const server = await this.getServer(id, context);
    if (!server) return;
    if (server.state !== 'stopped') await this.powerOff(id, context);
    const root = server.storageDevices.find(
      (d) => d.address === 'virtio:0' || d.bootDisk === '1'
    )?.storage;
    try {
      await this.request(
        `/server/${encodeURIComponent(id)}?storages=0`,
        { method: 'DELETE' },
        context
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (isUpCloudNotFound(error)) return;
      throw error;
    }
    if (root) await this.deleteStorageIdempotent(root, context);
  }
  async getVM(id: string, context?: ProviderRequestContext): Promise<VMInstance | null> {
    throwIfProviderRequestAborted(context);
    const server = await this.getServer(id, context);
    return server ? toUpCloudVM(server) : null;
  }
  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const response = await this.request('/server', {}, context);
    const servers = validateUpCloudServersResponse(
      await parseProviderJson(response, 'upcloud', 'listVMs'),
      'listVMs'
    );
    return servers.filter((server) => matchesUpCloudLabels(server.labels, labels)).map(toUpCloudVM);
  }
  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.request(
      `/server/${encodeURIComponent(id)}/stop`,
      {
        method: 'POST',
        body: JSON.stringify({
          stop_server: { stop_type: 'soft', timeout: String(this.stopTimeoutSeconds) },
        }),
      },
      context
    );
    await this.waitForState(id, 'stopped', context);
  }
  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    await this.request(`/server/${encodeURIComponent(id)}/start`, { method: 'POST' }, context);
  }
  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    const response = await this.request('/account', {}, context);
    validateUpCloudAccountResponse(
      await parseProviderJson(response, 'upcloud', 'validateToken'),
      'validateToken'
    );
    return true;
  }
  async createVolume(
    config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    await this.assertZoneAvailable(config.location, context);
    assertUpCloudVolumeSize(config.sizeGb, UPCLOUD_VOLUME_MIN_SIZE_GB, UPCLOUD_VOLUME_MAX_SIZE_GB);
    const response = await this.request(
      '/storage',
      {
        method: 'POST',
        body: JSON.stringify({
          storage: {
            zone: config.location,
            title: config.name,
            size: config.sizeGb,
            tier: 'maxiops',
            encrypted: 'yes',
            labels: toUpCloudLabels(config.labels),
          },
        }),
      },
      context
    );
    return toUpCloudVolume(
      validateUpCloudStorageResponse(
        await parseProviderJson(response, 'upcloud', 'createVolume'),
        'createVolume'
      )
    );
  }
  async attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    await this.assertLocations(config, context);
    const response = await this.request(
      `/server/${encodeURIComponent(config.serverId)}/storage/attach`,
      {
        method: 'POST',
        body: JSON.stringify({
          storage_device: {
            type: 'disk',
            address: 'virtio',
            storage: config.volumeId,
            boot_disk: '0',
          },
        }),
      },
      context
    );
    const server = validateUpCloudServerResponse(
      await parseProviderJson(response, 'upcloud', 'attachVolume'),
      'attachVolume'
    );
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) throw new ProviderError('upcloud', 404, 'UpCloud storage not found after attach');
    const device = server.storageDevices.find((d) => d.storage === config.volumeId);
    return {
      ...volume,
      attachedServerId: config.serverId,
      linuxDevice: upCloudDevicePath(device?.address),
    };
  }
  async detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    if (!config.serverId)
      throw new ProviderError('upcloud', 400, 'UpCloud detach requires serverId', {
        category: 'invalid_config',
      });
    const current = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!current) return null;
    if (!current.attachedServerId) return current;
    try {
      await this.request(
        `/server/${encodeURIComponent(config.serverId)}/storage/detach`,
        {
          method: 'POST',
          body: JSON.stringify({ storage_device: { storage: config.volumeId } }),
        },
        context
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (!isUpCloudNotFound(error)) throw error;
    }
    return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
  }
  async resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    const current = config.currentSizeGb ?? (await this.requireVolume(config, context)).sizeGb;
    if (config.sizeGb < current)
      throw new ProviderError('upcloud', 400, 'UpCloud storage cannot be shrunk', {
        category: 'invalid_config',
      });
    if (config.sizeGb === current) return this.requireVolume(config, context);
    assertUpCloudVolumeSize(config.sizeGb, UPCLOUD_VOLUME_MIN_SIZE_GB, UPCLOUD_VOLUME_MAX_SIZE_GB);
    const response = await this.request(
      `/storage/${encodeURIComponent(config.volumeId)}`,
      {
        method: 'PUT',
        body: JSON.stringify({ storage: { size: config.sizeGb } }),
      },
      context
    );
    return toUpCloudVolume(
      validateUpCloudStorageResponse(
        await parseProviderJson(response, 'upcloud', 'resizeVolume'),
        'resizeVolume'
      )
    );
  }
  async deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(config, context);
    if (!volume) return;
    if (volume.attachedServerId)
      throw new ProviderError('upcloud', 409, 'Detach UpCloud storage before deleting it', {
        category: 'invalid_config',
      });
    await this.deleteStorageIdempotent(config.volumeId, context);
  }
  async getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await this.request(
        `/storage/${encodeURIComponent(config.volumeId)}`,
        {},
        context
      );
      const storage = validateUpCloudStorageResponse(
        await parseProviderJson(response, 'upcloud', 'getVolume'),
        'getVolume'
      );
      if (storage.zone && storage.zone !== config.location)
        throw new ProviderError('upcloud', 400, 'UpCloud storage location mismatch', {
          category: 'invalid_config',
        });
      return toUpCloudVolume(storage);
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (isUpCloudNotFound(error)) return null;
      throw error;
    }
  }
  async listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    const response = await this.request('/storage/normal', {}, context);
    return validateUpCloudStoragesResponse(
      await parseProviderJson(response, 'upcloud', 'listVolumes'),
      'listVolumes'
    )
      .filter((s) => s.zone === config.location && matchesUpCloudLabels(s.labels, config.labels))
      .map(toUpCloudVolume);
  }
  private async getServer(id: string, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    try {
      const response = await this.request(`/server/${encodeURIComponent(id)}`, {}, context);
      return validateUpCloudServerResponse(
        await parseProviderJson(response, 'upcloud', 'getVM'),
        'getVM'
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (isUpCloudNotFound(error)) return null;
      throw error;
    }
  }
  private async assertZoneAvailable(zone: string, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    if (!this.zoneNames) {
      const response = await this.request('/zone', {}, context);
      const zoneNames = new Set(
        validateUpCloudZonesResponse(
          await parseProviderJson(response, 'upcloud', 'zones'),
          'zones'
        ).map((value) => value.id)
      );
      throwIfProviderRequestAborted(context);
      this.zoneNames = zoneNames;
    }
    throwIfProviderRequestAborted(context);
    if (!this.zoneNames.has(zone))
      throw new ProviderError('upcloud', 400, 'UpCloud zone is not currently available: ' + zone, {
        category: 'invalid_config',
      });
  }
  private async assertPlanAvailable(plan: string, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    if (!this.planNames) {
      const response = await this.request('/plan', {}, context);
      const planNames = new Set(
        validateUpCloudPlansResponse(
          await parseProviderJson(response, 'upcloud', 'plans'),
          'plans'
        ).map((value) => value.name)
      );
      throwIfProviderRequestAborted(context);
      this.planNames = planNames;
    }
    throwIfProviderRequestAborted(context);
    if (!this.planNames.has(plan))
      throw new ProviderError('upcloud', 400, 'UpCloud plan is not currently available: ' + plan, {
        category: 'invalid_config',
      });
  }
  private async resolveTemplate(context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    if (this.templateId) return this.templateId;
    const response = await this.request('/storage/template', {}, context);
    const templates = validateUpCloudStoragesResponse(
      await parseProviderJson(response, 'upcloud', 'templates'),
      'templates'
    );
    const found = templates.find(
      (t) =>
        t.templateType === 'cloud-init' &&
        t.title.toLowerCase().includes(this.imageTitle.toLowerCase())
    );
    if (!found)
      throw new ProviderError('upcloud', 400, `No cloud-init template matches ${this.imageTitle}`, {
        category: 'invalid_config',
      });
    throwIfProviderRequestAborted(context);
    this.templateId = found.uuid;
    return found.uuid;
  }
  private async pollForIp(server: UpCloudServer, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (!publicUpCloudIPv4(server) && Date.now() < deadline) {
      await providerDelay(
        Math.min(this.ipPollIntervalMs, Math.max(0, deadline - Date.now())),
        context
      );
      const next = await this.getServer(server.uuid, context);
      if (!next) break;
      server = next;
    }
    throwIfProviderRequestAborted(context);
    if (!publicUpCloudIPv4(server))
      this.logger.warn('upcloud.ip_poll_timeout', { serverId: server.uuid });
    return server;
  }
  private async waitForState(id: string, state: string, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (Date.now() < deadline) {
      const server = await this.getServer(id, context);
      if (!server || server.state === state) return;
      await providerDelay(
        Math.min(this.ipPollIntervalMs, Math.max(0, deadline - Date.now())),
        context
      );
    }
    throwIfProviderRequestAborted(context);
    throw new ProviderError(
      'upcloud',
      409,
      `Timed out waiting for server ${id} to become ${state}`
    );
  }
  private async assertLocations(config: VolumeAttachmentConfig, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    const [volume, server] = await Promise.all([
      this.requireVolume({ volumeId: config.volumeId, location: config.location }, context),
      this.getServer(config.serverId, context),
    ]);
    throwIfProviderRequestAborted(context);
    if (!server) throw new ProviderError('upcloud', 404, 'UpCloud server not found');
    if (volume.location !== config.location || server.zone !== config.location)
      throw new ProviderError(
        'upcloud',
        400,
        'UpCloud storage and server must be in the same zone',
        { category: 'invalid_config' }
      );
  }
  private async requireVolume(config: VolumeLookupConfig, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    const value = await this.getVolume(config, context);
    if (!value) throw new ProviderError('upcloud', 404, 'UpCloud storage not found');
    return value;
  }
  private async deleteStorageIdempotent(id: string, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    try {
      await this.request(`/storage/${encodeURIComponent(id)}`, { method: 'DELETE' }, context);
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (!isUpCloudNotFound(error)) throw error;
    }
  }
  private async request(path: string, init: RequestInit = {}, context?: ProviderRequestContext) {
    throwIfProviderRequestAborted(context);
    try {
      return await providerFetch(
        'upcloud',
        this.apiUrl + path,
        {
          ...init,
          headers: {
            Authorization: this.auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...init.headers,
          },
        },
        getTimeoutMs(undefined, this.requestTimeoutMs),
        undefined,
        context
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (error instanceof ProviderError)
        throw new ProviderError('upcloud', error.statusCode, error.message, {
          providerCode: error.providerCode,
          category: classifyUpCloudError(error.statusCode, error.message, error.providerCode),
          cause: error,
        });
      throw error;
    }
  }
}
export { classifyUpCloudError, mapUpCloudStatus } from './upcloud-utils';
