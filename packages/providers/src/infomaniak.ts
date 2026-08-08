import type { VMSize } from '@simple-agent-manager/shared';

import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import {
  type LocationMeta,
  noopProviderLogger,
  type Provider,
  ProviderError,
  type ProviderErrorCategory,
  type ProviderLogger,
  type ProviderRequestContext,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
  type SizeConfig,
  type VMConfig,
  type VMInstance,
  type VMStatus,
  type VolumeAttachmentConfig,
  type VolumeCapabilities,
  type VolumeConfig,
  type VolumeDetachConfig,
  type VolumeInstance,
  type VolumeListConfig,
  type VolumeLookupConfig,
  type VolumeResizeConfig,
  type VolumeStatus,
} from './types';

export const DEFAULT_INFOMANIAK_AUTH_URL = 'https://api.pub1.infomaniak.cloud/identity/v3';
export const DEFAULT_INFOMANIAK_REGION = 'dc4-a';
export const DEFAULT_INFOMANIAK_ENDPOINT_INTERFACE = 'public';
export const DEFAULT_INFOMANIAK_NETWORK_NAME = 'ext-net1';
export const DEFAULT_INFOMANIAK_IMAGE_NAME = 'Ubuntu 24.04 noble';
export const DEFAULT_INFOMANIAK_VOLUME_TYPE = 'CEPH_1_perf1';
export const DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS = 45_000;
export const DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS = 3_000;
export const INFOMANIAK_VOLUME_MIN_SIZE_GB = 1;
export const INFOMANIAK_VOLUME_MAX_SIZE_GB = 10_240;
export const INFOMANIAK_LOCATIONS = ['dc3-a', 'dc4-a'] as const;

const LOCATIONS: Readonly<Record<string, LocationMeta>> = {
  'dc3-a': { name: 'Geneva (DC3)', country: 'CH' },
  'dc4-a': { name: 'Geneva (DC4)', country: 'CH' },
};
const FLAVORS: Readonly<Record<VMSize, string>> = {
  small: 'a2-ram4-disk20-perf1',
  medium: 'a4-ram8-disk20-perf1',
  large: 'a8-ram16-disk20-perf1',
};
const SIZES: Readonly<Record<VMSize, SizeConfig>> = {
  small: { type: FLAVORS.small, price: 'usage-based', vcpu: 2, ramGb: 4, storageGb: 20 },
  medium: { type: FLAVORS.medium, price: 'usage-based', vcpu: 4, ramGb: 8, storageGb: 20 },
  large: { type: FLAVORS.large, price: 'usage-based', vcpu: 8, ramGb: 16, storageGb: 20 },
};
export const INFOMANIAK_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: 1,
  maxSizeGb: 10_240,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'Volumes and servers must use the same Infomaniak region.',
    'Resize is grow-only and requires the volume to be detached first.',
    'Discover devices under /dev/disk/by-id using the Cinder volume ID; requested device names are unsupported.',
  ],
};

export interface InfomaniakProviderOptions {
  authUrl?: string;
  region?: string;
  endpointInterface?: string;
  networkName?: string;
  imageName?: string;
  volumeType?: string;
  flavors?: Partial<Record<VMSize, string>>;
  requestTimeoutMs?: number;
  ipPollTimeoutMs?: number;
  ipPollIntervalMs?: number;
  logger?: ProviderLogger;
}
interface Endpoints {
  compute: string;
  volumev3: string;
  image: string;
  network: string;
}
interface Session {
  token: string;
  endpoints: Endpoints;
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value as Record<string, unknown>;
}
function asArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
function asString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value)
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new ProviderError('infomaniak', undefined, `Invalid Infomaniak response at ${path}`);
  return value;
}
function metadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}
function base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary);
}
export function classifyInfomaniakError(
  status: number | undefined,
  message: string
): ProviderErrorCategory {
  if (status === 401 || status === 403) return 'auth_error';
  if (status === 409 && /quota/i.test(message)) return 'quota_exceeded';
  if (status === 409 || status === 503 || /capacity|no valid host/i.test(message))
    return 'transient_capacity';
  if (status === 429) return 'rate_limited';
  if (status === 400 || status === 404 || status === 422) return 'invalid_config';
  return 'unknown';
}
export function mapInfomaniakStatus(status: string): VMStatus {
  switch (status.toUpperCase()) {
    case 'ACTIVE':
      return 'running';
    case 'SHUTOFF':
    case 'STOPPED':
    case 'PAUSED':
    case 'SUSPENDED':
      return 'off';
    case 'REBOOT':
    case 'HARD_REBOOT':
      return 'starting';
    default:
      return 'initializing';
  }
}
function volumeStatus(status: string): VolumeStatus {
  switch (status.toLowerCase()) {
    case 'creating':
      return 'creating';
    case 'available':
      return 'available';
    case 'attaching':
      return 'attaching';
    case 'in-use':
      return 'attached';
    case 'detaching':
      return 'detaching';
    case 'extending':
      return 'resizing';
    case 'deleting':
      return 'deleting';
    default:
      return 'unknown';
  }
}

export class InfomaniakProvider implements Provider {
  readonly name = 'infomaniak';
  readonly locations = INFOMANIAK_LOCATIONS;
  readonly locationMetadata = LOCATIONS;
  readonly sizes = SIZES;
  readonly volumeCapabilities = INFOMANIAK_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;
  private readonly authUrl: string;
  private readonly region: string;
  private readonly endpointInterface: string;
  private readonly networkName: string;
  private readonly imageName: string;
  private readonly volumeType: string;
  private readonly flavors: Readonly<Record<VMSize, string>>;
  private readonly timeout: number;
  private readonly pollTimeout: number;
  private readonly pollInterval: number;
  private readonly logger: ProviderLogger;
  private session?: Session;

  constructor(
    private readonly credentialId: string,
    private readonly credentialSecret: string,
    options: InfomaniakProviderOptions = {}
  ) {
    this.authUrl = (options.authUrl ?? DEFAULT_INFOMANIAK_AUTH_URL).replace(/\/$/, '');
    this.region = options.region ?? DEFAULT_INFOMANIAK_REGION;
    this.defaultLocation = this.region;
    this.endpointInterface = options.endpointInterface ?? DEFAULT_INFOMANIAK_ENDPOINT_INTERFACE;
    this.networkName = options.networkName ?? DEFAULT_INFOMANIAK_NETWORK_NAME;
    this.imageName = options.imageName ?? DEFAULT_INFOMANIAK_IMAGE_NAME;
    this.volumeType = options.volumeType ?? DEFAULT_INFOMANIAK_VOLUME_TYPE;
    this.flavors = { ...FLAVORS, ...options.flavors };
    this.timeout = options.requestTimeoutMs ?? DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS;
    this.pollTimeout = options.ipPollTimeoutMs ?? DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS;
    this.pollInterval = options.ipPollIntervalMs ?? DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS;
    this.logger = options.logger ?? noopProviderLogger;
  }

  private async authenticate(force = false, context?: ProviderRequestContext): Promise<Session> {
    throwIfProviderRequestAborted(context);
    if (this.session && !force) return this.session;
    const response = await providerFetch(
      'infomaniak',
      `${this.authUrl}/auth/tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          auth: {
            identity: {
              methods: ['application_credential'],
              application_credential: { id: this.credentialId, secret: this.credentialSecret },
            },
          },
        }),
      },
      this.timeout,
      undefined,
      context
    );
    const token = response.headers.get('x-subject-token');
    if (!token)
      throw new ProviderError(
        'infomaniak',
        undefined,
        'Invalid Keystone response: missing X-Subject-Token'
      );
    const tokenBody = asRecord(asRecord(await response.json(), 'root').token, 'token');
    const projectId = asString(asRecord(tokenBody.project, 'token.project').id, 'token.project.id');
    const catalog = asArray(tokenBody.catalog, 'token.catalog').map((value, i) =>
      asRecord(value, `catalog[${i}]`)
    );
    const endpoint = (type: string): string => {
      const service = catalog.find((item) => item.type === type);
      if (!service)
        throw new ProviderError('infomaniak', undefined, `Keystone catalog is missing ${type}`);
      const match = asArray(service.endpoints, `${type}.endpoints`)
        .map((value, i) => asRecord(value, `${type}.endpoints[${i}]`))
        .find((item) => item.region === this.region && item.interface === this.endpointInterface);
      if (!match)
        throw new ProviderError(
          'infomaniak',
          undefined,
          `Keystone catalog has no ${this.endpointInterface} ${type} endpoint for ${this.region}`
        );
      return asString(match.url, `${type}.url`)
        .replace(/\/$/, '')
        .replace('%(project_id)s', projectId);
    };
    throwIfProviderRequestAborted(context);
    const session = {
      token,
      endpoints: {
        compute: endpoint('compute'),
        volumev3: endpoint('volumev3'),
        image: endpoint('image'),
        network: endpoint('network'),
      },
    };
    this.session = session;
    return session;
  }

  private async request(
    url: string,
    init: RequestInit = {},
    allow404 = false,
    context?: ProviderRequestContext
  ): Promise<Response | null> {
    throwIfProviderRequestAborted(context);
    const session = await this.authenticate(false, context);
    try {
      return await providerFetch(
        'infomaniak',
        url,
        {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            'X-Auth-Token': session.token,
            ...init.headers,
          },
        },
        this.timeout,
        undefined,
        context
      );
    } catch (error) {
      rethrowIfProviderRequestAborted(error, context);
      if (allow404 && error instanceof ProviderError && error.statusCode === 404) return null;
      if (error instanceof ProviderError)
        throw new ProviderError('infomaniak', error.statusCode, error.message, {
          cause: error,
          providerCode: error.providerCode,
          category: classifyInfomaniakError(error.statusCode, error.message),
        });
      throw error;
    }
  }
  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    await this.authenticate(true, context);
    return true;
  }

  private async resolve(
    endpoint: string,
    path: string,
    key: string,
    name: string,
    context?: ProviderRequestContext
  ): Promise<string> {
    const response = await this.request(
      `${endpoint}/${path}?name=${encodeURIComponent(name)}`,
      {},
      false,
      context
    );
    const values = asArray(asRecord(await response?.json(), path)[key], key).map((value, i) =>
      asRecord(value, `${key}[${i}]`)
    );
    const match = values.find((value) => value.name === name);
    throwIfProviderRequestAborted(context);
    if (!match)
      throw new ProviderError('infomaniak', 404, `${name} was not found in Infomaniak ${key}`, {
        category: 'invalid_config',
      });
    return asString(match.id, `${key}.id`);
  }
  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    if (config.location !== this.region)
      throw new ProviderError(
        'infomaniak',
        400,
        `VM region ${config.location} does not match credential region ${this.region}`,
        { category: 'invalid_config' }
      );
    const session = await this.authenticate(false, context);
    const [imageRef, flavorRef, networkId] = await Promise.all([
      this.resolve(
        session.endpoints.image,
        'v2/images',
        'images',
        config.image ?? this.imageName,
        context
      ),
      this.resolve(
        session.endpoints.compute,
        'flavors/detail',
        'flavors',
        this.flavors[config.size],
        context
      ),
      this.resolve(
        session.endpoints.network,
        'v2.0/networks',
        'networks',
        this.networkName,
        context
      ),
    ]);
    throwIfProviderRequestAborted(context);
    const response = await this.request(
      `${session.endpoints.compute}/servers`,
      {
        method: 'POST',
        body: JSON.stringify({
          server: {
            name: config.name,
            imageRef,
            flavorRef,
            networks: [{ uuid: networkId }],
            user_data: base64(config.userData),
            metadata: config.labels ?? {},
          },
        }),
      },
      false,
      context
    );
    const id = asString(
      asRecord(asRecord(await response?.json(), 'create').server, 'server').id,
      'server.id'
    );
    const deadline = Date.now() + this.pollTimeout;
    let vm = await this.getVM(id, context);
    while (vm && !vm.ip && Date.now() < deadline) {
      await providerDelay(Math.min(this.pollInterval, deadline - Date.now()), context);
      vm = await this.getVM(id, context);
    }
    throwIfProviderRequestAborted(context);
    if (!vm) throw new ProviderError('infomaniak', undefined, `Created server ${id} was not found`);
    if (!vm.ip)
      this.logger.warn('Infomaniak VM has no public IPv4 yet', {
        serverId: id,
        region: this.region,
      });
    return vm;
  }
  private vm(value: unknown): VMInstance {
    const server = asRecord(value, 'server');
    const addressGroups = asRecord(server.addresses ?? {}, 'server.addresses');
    const addresses = Object.values(addressGroups)
      .flatMap((value) => (Array.isArray(value) ? value : []))
      .map((value) => asRecord(value, 'address'));
    const ipv4 = addresses.find(
      (address) => address.version === 4 && typeof address.addr === 'string'
    );
    const flavor = asRecord(server.flavor, 'server.flavor');
    return {
      id: asString(server.id, 'server.id'),
      name: asString(server.name, 'server.name'),
      ip: typeof ipv4?.addr === 'string' ? ipv4.addr : '',
      status: mapInfomaniakStatus(asString(server.status, 'server.status')),
      serverType:
        typeof flavor.original_name === 'string'
          ? flavor.original_name
          : asString(flavor.id, 'flavor.id'),
      createdAt: asString(server.created, 'server.created'),
      labels: metadata(server.metadata),
    };
  }
  async getVM(id: string, context?: ProviderRequestContext): Promise<VMInstance | null> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    const r = await this.request(`${s.endpoints.compute}/servers/${id}`, {}, true, context);
    return r ? this.vm(asRecord(await r.json(), 'root').server) : null;
  }
  async listVMs(
    filter?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    const r = await this.request(`${s.endpoints.compute}/servers/detail`, {}, false, context);
    const values = asArray(asRecord(await r?.json(), 'root').servers, 'servers').map((value) =>
      this.vm(value)
    );
    return filter
      ? values.filter((vm) =>
          Object.entries(filter).every(([key, value]) => vm.labels[key] === value)
        )
      : values;
  }
  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    await this.request(`${s.endpoints.compute}/servers/${id}`, { method: 'DELETE' }, true, context);
  }
  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    await this.request(
      `${s.endpoints.compute}/servers/${id}/action`,
      {
        method: 'POST',
        body: JSON.stringify({ 'os-stop': null }),
      },
      false,
      context
    );
  }
  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    await this.request(
      `${s.endpoints.compute}/servers/${id}/action`,
      {
        method: 'POST',
        body: JSON.stringify({ 'os-start': null }),
      },
      false,
      context
    );
  }

  private volume(value: unknown): VolumeInstance {
    const volume = asRecord(value, 'volume');
    const attachments = Array.isArray(volume.attachments)
      ? volume.attachments.map((value) => asRecord(value, 'attachment'))
      : [];
    const id = asString(volume.id, 'volume.id');
    const attachment = attachments[0];
    return {
      id,
      name: typeof volume.name === 'string' && volume.name ? volume.name : id,
      sizeGb: asNumber(volume.size, 'volume.size'),
      location: this.region,
      status: volumeStatus(asString(volume.status, 'volume.status')),
      attachedServerId:
        typeof attachment?.server_id === 'string' ? attachment.server_id : undefined,
      linuxDevice: `/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_${id.slice(0, 20)}`,
      volumeType: typeof volume.volume_type === 'string' ? volume.volume_type : undefined,
      createdAt: asString(volume.created_at, 'volume.created_at'),
      labels: metadata(volume.metadata),
    };
  }
  async createVolume(
    config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    if (config.location !== this.region)
      throw new ProviderError('infomaniak', 400, 'Volume and credential regions must match', {
        category: 'invalid_config',
      });
    if (
      config.sizeGb < INFOMANIAK_VOLUME_MIN_SIZE_GB ||
      config.sizeGb > INFOMANIAK_VOLUME_MAX_SIZE_GB
    )
      throw new ProviderError(
        'infomaniak',
        400,
        [
          'Volume size must be between',
          INFOMANIAK_VOLUME_MIN_SIZE_GB,
          'and',
          INFOMANIAK_VOLUME_MAX_SIZE_GB,
          'GB',
        ].join(' '),
        {
          category: 'invalid_config',
        }
      );
    const s = await this.authenticate(false, context);
    const r = await this.request(
      `${s.endpoints.volumev3}/volumes`,
      {
        method: 'POST',
        body: JSON.stringify({
          volume: {
            name: config.name,
            size: config.sizeGb,
            volume_type: this.volumeType,
            metadata: config.labels ?? {},
          },
        }),
      },
      false,
      context
    );
    return this.volume(asRecord(await r?.json(), 'root').volume);
  }
  async getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    const r = await this.request(
      `${s.endpoints.volumev3}/volumes/${config.volumeId}`,
      {},
      true,
      context
    );
    return r ? this.volume(asRecord(await r.json(), 'root').volume) : null;
  }
  async listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    const r = await this.request(`${s.endpoints.volumev3}/volumes/detail`, {}, false, context);
    const values = asArray(asRecord(await r?.json(), 'root').volumes, 'volumes').map((value) =>
      this.volume(value)
    );
    return config.labels
      ? values.filter((volume) =>
          Object.entries(config.labels ?? {}).every(([key, value]) => volume.labels[key] === value)
        )
      : values;
  }
  async deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const current = await this.getVolume(config, context);
    if (!current) return;
    if (current.attachedServerId)
      throw new ProviderError(
        'infomaniak',
        409,
        'Refusing to delete an attached Infomaniak volume',
        { category: 'invalid_config' }
      );
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    await this.request(
      `${s.endpoints.volumev3}/volumes/${config.volumeId}`,
      { method: 'DELETE' },
      true,
      context
    );
  }
  async attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    if (config.location !== this.region)
      throw new ProviderError('infomaniak', 400, 'Server and volume regions must match', {
        category: 'invalid_config',
      });
    const s = await this.authenticate(false, context);
    await this.request(
      `${s.endpoints.compute}/servers/${config.serverId}/os-volume_attachments`,
      {
        method: 'POST',
        body: JSON.stringify({ volumeAttachment: { volumeId: config.volumeId } }),
      },
      false,
      context
    );
    const result = await this.getVolume(config, context);
    if (!result) throw new ProviderError('infomaniak', 404, 'Attached volume was not found');
    return result;
  }
  async detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    const current = await this.getVolume(config, context);
    if (!current?.attachedServerId) return current;
    const serverId = config.serverId ?? current.attachedServerId;
    const s = await this.authenticate(false, context);
    const r = await this.request(
      `${s.endpoints.compute}/servers/${serverId}/os-volume_attachments`,
      {},
      false,
      context
    );
    const attachments = asArray(
      asRecord(await r?.json(), 'root').volumeAttachments,
      'volumeAttachments'
    ).map((value) => asRecord(value, 'attachment'));
    const match = attachments.find((item) => item.volumeId === config.volumeId);
    throwIfProviderRequestAborted(context);
    if (match)
      await this.request(
        `${s.endpoints.compute}/servers/${serverId}/os-volume_attachments/${asString(match.id, 'attachment.id')}`,
        { method: 'DELETE' },
        true,
        context
      );
    return this.getVolume(config, context);
  }
  async resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    const current = await this.getVolume(config, context);
    if (!current)
      throw new ProviderError('infomaniak', 404, 'Volume not found', {
        category: 'invalid_config',
      });
    if (config.sizeGb <= (config.currentSizeGb ?? current.sizeGb))
      throw new ProviderError('infomaniak', 400, 'Infomaniak volumes can only be grown', {
        category: 'invalid_config',
      });
    if (current.attachedServerId)
      throw new ProviderError('infomaniak', 409, 'Detach the Infomaniak volume before resizing', {
        category: 'invalid_config',
      });
    throwIfProviderRequestAborted(context);
    const s = await this.authenticate(false, context);
    await this.request(
      `${s.endpoints.volumev3}/volumes/${config.volumeId}/action`,
      {
        method: 'POST',
        body: JSON.stringify({ 'os-extend': { new_size: config.sizeGb } }),
      },
      false,
      context
    );
    const result = await this.getVolume(config, context);
    if (!result) throw new ProviderError('infomaniak', 404, 'Resized volume was not found');
    return result;
  }
}
