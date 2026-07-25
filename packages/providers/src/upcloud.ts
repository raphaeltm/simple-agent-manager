import type { VMSize } from '@simple-agent-manager/shared';

import { getTimeoutMs, providerFetch } from './provider-fetch';
import type {
  Provider,
  ProviderLogger,
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
  upCloudDelay,
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
  async createVM(config: VMConfig): Promise<VMInstance> {
    await this.assertZoneAvailable(config.location);
    await this.assertPlanAvailable(this.sizes[config.size].type);
    const template = config.image ?? (await this.resolveTemplate());
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
    const response = await this.request('/server', { method: 'POST', body: JSON.stringify(body) });
    let server = validateUpCloudServerResponse(
      await parseProviderJson(response, 'upcloud', 'createVM'),
      'createVM'
    );
    server = await this.pollForIp(server);
    return toUpCloudVM(server);
  }
  async deleteVM(id: string): Promise<void> {
    const server = await this.getServer(id);
    if (!server) return;
    if (server.state !== 'stopped') await this.powerOff(id);
    const root = server.storageDevices.find(
      (d) => d.address === 'virtio:0' || d.bootDisk === '1'
    )?.storage;
    try {
      await this.request(`/server/${encodeURIComponent(id)}?storages=0`, { method: 'DELETE' });
    } catch (error) {
      if (isUpCloudNotFound(error)) return;
      throw error;
    }
    if (root) await this.deleteStorageIdempotent(root);
  }
  async getVM(id: string): Promise<VMInstance | null> {
    const server = await this.getServer(id);
    return server ? toUpCloudVM(server) : null;
  }
  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const response = await this.request('/server');
    const servers = validateUpCloudServersResponse(
      await parseProviderJson(response, 'upcloud', 'listVMs'),
      'listVMs'
    );
    return servers.filter((server) => matchesUpCloudLabels(server.labels, labels)).map(toUpCloudVM);
  }
  async powerOff(id: string): Promise<void> {
    await this.request(`/server/${encodeURIComponent(id)}/stop`, {
      method: 'POST',
      body: JSON.stringify({
        stop_server: { stop_type: 'soft', timeout: String(this.stopTimeoutSeconds) },
      }),
    });
    await this.waitForState(id, 'stopped');
  }
  async powerOn(id: string): Promise<void> {
    await this.request(`/server/${encodeURIComponent(id)}/start`, { method: 'POST' });
  }
  async validateToken(): Promise<boolean> {
    const response = await this.request('/account');
    validateUpCloudAccountResponse(
      await parseProviderJson(response, 'upcloud', 'validateToken'),
      'validateToken'
    );
    return true;
  }
  async createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    await this.assertZoneAvailable(config.location);
    assertUpCloudVolumeSize(config.sizeGb, UPCLOUD_VOLUME_MIN_SIZE_GB, UPCLOUD_VOLUME_MAX_SIZE_GB);
    const response = await this.request('/storage', {
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
    });
    return toUpCloudVolume(
      validateUpCloudStorageResponse(
        await parseProviderJson(response, 'upcloud', 'createVolume'),
        'createVolume'
      )
    );
  }
  async attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    await this.assertLocations(config);
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
      }
    );
    const server = validateUpCloudServerResponse(
      await parseProviderJson(response, 'upcloud', 'attachVolume'),
      'attachVolume'
    );
    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) throw new ProviderError('upcloud', 404, 'UpCloud storage not found after attach');
    const device = server.storageDevices.find((d) => d.storage === config.volumeId);
    return {
      ...volume,
      attachedServerId: config.serverId,
      linuxDevice: upCloudDevicePath(device?.address),
    };
  }
  async detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    if (!config.serverId)
      throw new ProviderError('upcloud', 400, 'UpCloud detach requires serverId', {
        category: 'invalid_config',
      });
    const current = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!current) return null;
    if (!current.attachedServerId) return current;
    try {
      await this.request(`/server/${encodeURIComponent(config.serverId)}/storage/detach`, {
        method: 'POST',
        body: JSON.stringify({ storage_device: { storage: config.volumeId } }),
      });
    } catch (error) {
      if (!isUpCloudNotFound(error)) throw error;
    }
    return this.getVolume({ volumeId: config.volumeId, location: config.location });
  }
  async resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance> {
    const current = config.currentSizeGb ?? (await this.requireVolume(config)).sizeGb;
    if (config.sizeGb < current)
      throw new ProviderError('upcloud', 400, 'UpCloud storage cannot be shrunk', {
        category: 'invalid_config',
      });
    if (config.sizeGb === current) return this.requireVolume(config);
    assertUpCloudVolumeSize(config.sizeGb, UPCLOUD_VOLUME_MIN_SIZE_GB, UPCLOUD_VOLUME_MAX_SIZE_GB);
    const response = await this.request(`/storage/${encodeURIComponent(config.volumeId)}`, {
      method: 'PUT',
      body: JSON.stringify({ storage: { size: config.sizeGb } }),
    });
    return toUpCloudVolume(
      validateUpCloudStorageResponse(
        await parseProviderJson(response, 'upcloud', 'resizeVolume'),
        'resizeVolume'
      )
    );
  }
  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    const volume = await this.getVolume(config);
    if (!volume) return;
    if (volume.attachedServerId)
      throw new ProviderError('upcloud', 409, 'Detach UpCloud storage before deleting it', {
        category: 'invalid_config',
      });
    await this.deleteStorageIdempotent(config.volumeId);
  }
  async getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    try {
      const response = await this.request(`/storage/${encodeURIComponent(config.volumeId)}`);
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
      if (isUpCloudNotFound(error)) return null;
      throw error;
    }
  }
  async listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    const response = await this.request('/storage/normal');
    return validateUpCloudStoragesResponse(
      await parseProviderJson(response, 'upcloud', 'listVolumes'),
      'listVolumes'
    )
      .filter((s) => s.zone === config.location && matchesUpCloudLabels(s.labels, config.labels))
      .map(toUpCloudVolume);
  }
  private async getServer(id: string) {
    try {
      const response = await this.request(`/server/${encodeURIComponent(id)}`);
      return validateUpCloudServerResponse(
        await parseProviderJson(response, 'upcloud', 'getVM'),
        'getVM'
      );
    } catch (error) {
      if (isUpCloudNotFound(error)) return null;
      throw error;
    }
  }
  private async assertZoneAvailable(zone: string) {
    if (!this.zoneNames) {
      const response = await this.request('/zone');
      this.zoneNames = new Set(
        validateUpCloudZonesResponse(
          await parseProviderJson(response, 'upcloud', 'zones'),
          'zones'
        ).map((value) => value.id)
      );
    }
    if (!this.zoneNames.has(zone))
      throw new ProviderError('upcloud', 400, 'UpCloud zone is not currently available: ' + zone, {
        category: 'invalid_config',
      });
  }
  private async assertPlanAvailable(plan: string) {
    if (!this.planNames) {
      const response = await this.request('/plan');
      this.planNames = new Set(
        validateUpCloudPlansResponse(
          await parseProviderJson(response, 'upcloud', 'plans'),
          'plans'
        ).map((value) => value.name)
      );
    }
    if (!this.planNames.has(plan))
      throw new ProviderError('upcloud', 400, 'UpCloud plan is not currently available: ' + plan, {
        category: 'invalid_config',
      });
  }
  private async resolveTemplate() {
    if (this.templateId) return this.templateId;
    const response = await this.request('/storage/template');
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
    return (this.templateId = found.uuid);
  }
  private async pollForIp(server: UpCloudServer) {
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (!publicUpCloudIPv4(server) && Date.now() < deadline) {
      await upCloudDelay(Math.min(this.ipPollIntervalMs, Math.max(0, deadline - Date.now())));
      const next = await this.getServer(server.uuid);
      if (!next) break;
      server = next;
    }
    if (!publicUpCloudIPv4(server))
      this.logger.warn('upcloud.ip_poll_timeout', { serverId: server.uuid });
    return server;
  }
  private async waitForState(id: string, state: string) {
    const deadline = Date.now() + this.ipPollTimeoutMs;
    while (Date.now() < deadline) {
      const server = await this.getServer(id);
      if (!server || server.state === state) return;
      await upCloudDelay(Math.min(this.ipPollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    throw new ProviderError(
      'upcloud',
      409,
      `Timed out waiting for server ${id} to become ${state}`
    );
  }
  private async assertLocations(config: VolumeAttachmentConfig) {
    const [volume, server] = await Promise.all([
      this.requireVolume({ volumeId: config.volumeId, location: config.location }),
      this.getServer(config.serverId),
    ]);
    if (!server) throw new ProviderError('upcloud', 404, 'UpCloud server not found');
    if (volume.location !== config.location || server.zone !== config.location)
      throw new ProviderError(
        'upcloud',
        400,
        'UpCloud storage and server must be in the same zone',
        { category: 'invalid_config' }
      );
  }
  private async requireVolume(config: VolumeLookupConfig) {
    const value = await this.getVolume(config);
    if (!value) throw new ProviderError('upcloud', 404, 'UpCloud storage not found');
    return value;
  }
  private async deleteStorageIdempotent(id: string) {
    try {
      await this.request(`/storage/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (error) {
      if (!isUpCloudNotFound(error)) throw error;
    }
  }
  private async request(path: string, init: RequestInit = {}) {
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
        getTimeoutMs(undefined, this.requestTimeoutMs)
      );
    } catch (error) {
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
