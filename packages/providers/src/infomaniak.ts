import type { CredentialProvider, VMSize } from '@simple-agent-manager/shared';

import {
  applyInfomaniakBootVolumeSize,
  assertInfomaniakRequestedBootVolumeAllowed,
  INFOMANIAK_BOOT_VOLUME_LIMITS,
  infomaniakBootVolumeMapping,
  infomaniakDefaultBootVolumeGb,
  infomaniakObservedResources,
  infomaniakServerMetadata,
  resolveInfomaniakBootVolumeSizeGb,
} from './infomaniak-boot-volume';
import {
  asArray,
  asRecord,
  asString,
  classifyInfomaniakError,
  DEFAULT_INFOMANIAK_AUTH_URL,
  DEFAULT_INFOMANIAK_ENDPOINT_INTERFACE,
  DEFAULT_INFOMANIAK_IMAGE_NAME,
  DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS,
  DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS,
  DEFAULT_INFOMANIAK_NETWORK_NAME,
  DEFAULT_INFOMANIAK_REGION,
  DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS,
  DEFAULT_INFOMANIAK_VOLUME_TYPE,
  INFOMANIAK_LOCATION_METADATA,
  INFOMANIAK_LOCATIONS,
  INFOMANIAK_VOLUME_CAPABILITIES,
  infomaniakBase64,
  infomaniakMetadata,
  mapInfomaniakStatus,
  mergeInfomaniakLegacySizes,
  optionalNonNegativeInteger,
  optionalPositiveInteger,
} from './infomaniak-metadata';
import {
  attachInfomaniakVolume,
  createInfomaniakVolume,
  deleteInfomaniakVolume,
  detachInfomaniakVolume,
  getInfomaniakVolume,
  type InfomaniakApi,
  listInfomaniakVolumes,
  resizeInfomaniakVolume,
} from './infomaniak-volumes';
import { getProviderCatalogOfferings } from './instance-offerings';
import { observedHardware, resolveVMConfigWithLegacySizeAdapter } from './native-vm-config';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import {
  noopProviderLogger,
  type Provider,
  ProviderError,
  type ProviderLogger,
  type ProviderOfferingListOptions,
  type ProviderRequestContext,
  type SizeConfig,
  type VMConfig,
  type VMInstance,
  type VolumeAttachmentConfig,
  type VolumeConfig,
  type VolumeDetachConfig,
  type VolumeInstance,
  type VolumeListConfig,
  type VolumeLookupConfig,
  type VolumeResizeConfig,
} from './types';

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
  /**
   * Size, in GB, of the Cinder volume new VMs boot from (admin setting `infomaniak.bootVolumeGb`).
   * Defaults to DEFAULT_INFOMANIAK_BOOT_VOLUME_GB; out-of-range values are rejected.
   */
  bootVolumeSizeGb?: number;
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

export class InfomaniakProvider implements Provider {
  readonly name = 'infomaniak';
  readonly locations = INFOMANIAK_LOCATIONS;
  readonly locationMetadata = INFOMANIAK_LOCATION_METADATA;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>>;
  readonly volumeCapabilities = INFOMANIAK_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;
  private readonly authUrl: string;
  private readonly region: string;
  private readonly endpointInterface: string;
  private readonly networkName: string;
  private readonly imageName: string;
  private readonly volumeType: string;
  private readonly bootVolumeSizeGb: number;
  private readonly timeout: number;
  private readonly pollTimeout: number;
  private readonly pollInterval: number;
  private readonly logger: ProviderLogger;
  private session?: Session;
  /** Session handed to the data-volume operations in infomaniak-volumes.ts. */
  private readonly api: InfomaniakApi;

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
    this.bootVolumeSizeGb = resolveInfomaniakBootVolumeSizeGb(options.bootVolumeSizeGb);
    this.sizes = mergeInfomaniakLegacySizes(options.flavors, this.bootVolumeSizeGb);
    this.timeout = options.requestTimeoutMs ?? DEFAULT_INFOMANIAK_REQUEST_TIMEOUT_MS;
    this.pollTimeout = options.ipPollTimeoutMs ?? DEFAULT_INFOMANIAK_IP_POLL_TIMEOUT_MS;
    this.pollInterval = options.ipPollIntervalMs ?? DEFAULT_INFOMANIAK_IP_POLL_INTERVAL_MS;
    this.logger = options.logger ?? noopProviderLogger;
    this.api = {
      region: this.region,
      volumeType: this.volumeType,
      endpoints: async (context) => (await this.authenticate(false, context)).endpoints,
      request: (url, init, allow404, context) => this.request(url, init, allow404, context),
    };
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

  async listInstanceOfferings(
    _options?: ProviderOfferingListOptions,
    context?: ProviderRequestContext
  ) {
    throwIfProviderRequestAborted(context);
    return applyInfomaniakBootVolumeSize(
      getProviderCatalogOfferings(
        this.name as CredentialProvider,
        this.locations,
        this.locationMetadata
      ),
      this.bootVolumeSizeGb
    );
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
    const nativeConfig = resolveVMConfigWithLegacySizeAdapter(config, {
      providerName: this.name,
      defaultLocation: this.region,
      legacySizes: this.sizes,
      defaultImage: this.imageName,
      defaultBootDiskSizeGb: (resolved, source) =>
        infomaniakDefaultBootVolumeGb(resolved, source, this.bootVolumeSizeGb),
      minBootDiskSizeGb: INFOMANIAK_BOOT_VOLUME_LIMITS.min,
      maxBootDiskSizeGb: INFOMANIAK_BOOT_VOLUME_LIMITS.max,
    });
    assertInfomaniakRequestedBootVolumeAllowed(
      config.native?.bootDiskSizeGb,
      this.bootVolumeSizeGb
    );
    // Resolution always sets bootDiskSizeGb (the default above returns a number); the fallback only
    // narrows the optional type.
    const bootVolumeGb = nativeConfig.bootDiskSizeGb ?? this.bootVolumeSizeGb;
    if (nativeConfig.location !== this.region)
      throw new ProviderError(
        'infomaniak',
        400,
        `VM region ${nativeConfig.location} does not match credential region ${this.region}`,
        { category: 'invalid_config' }
      );
    const session = await this.authenticate(false, context);
    const [imageId, flavorRef, networkId] = await Promise.all([
      this.resolve(
        session.endpoints.image,
        'v2/images',
        'images',
        nativeConfig.image ?? this.imageName,
        context
      ),
      this.resolve(
        session.endpoints.compute,
        'flavors/detail',
        'flavors',
        nativeConfig.instanceType,
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
          // Boot from a SAM-sized volume, not the flavor's local root disk (#2842). No imageRef:
          // Nova builds the volume from the image in the mapping.
          server: {
            name: nativeConfig.name,
            flavorRef,
            networks: [{ uuid: networkId }],
            block_device_mapping_v2: infomaniakBootVolumeMapping(imageId, bootVolumeGb),
            user_data: infomaniakBase64(nativeConfig.userData),
            metadata: infomaniakServerMetadata(nativeConfig.labels, bootVolumeGb),
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
    const serverType =
      typeof flavor.original_name === 'string'
        ? flavor.original_name
        : asString(flavor.id, 'flavor.id');
    const labels = infomaniakMetadata(server.metadata);
    const observed = infomaniakObservedResources({
      image: server.image,
      metadata: labels,
      vcpus: optionalPositiveInteger(flavor.vcpus, 'flavor.vcpus'),
      ramMb: optionalPositiveInteger(flavor.ram, 'flavor.ram'),
      flavorDiskGb: optionalNonNegativeInteger(flavor.disk, 'flavor.disk'),
    });
    return {
      id: asString(server.id, 'server.id'),
      name: asString(server.name, 'server.name'),
      ip: typeof ipv4?.addr === 'string' ? ipv4.addr : '',
      status: mapInfomaniakStatus(asString(server.status, 'server.status')),
      serverType,
      observedHardware: observedHardware({
        serverType,
        resources: observed.resources,
        unknownResourcesReason: observed.unknownReason,
      }),
      createdAt: asString(server.created, 'server.created'),
      labels,
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

  createVolume(config: VolumeConfig, context?: ProviderRequestContext): Promise<VolumeInstance> {
    return createInfomaniakVolume(this.api, config, context);
  }
  getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    return getInfomaniakVolume(this.api, config, context);
  }
  listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    return listInfomaniakVolumes(this.api, config, context);
  }
  deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    return deleteInfomaniakVolume(this.api, config, context);
  }
  attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    return attachInfomaniakVolume(this.api, config, context);
  }
  detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    return detachInfomaniakVolume(this.api, config, context);
  }
  resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    return resizeInfomaniakVolume(this.api, config, context);
  }
}
