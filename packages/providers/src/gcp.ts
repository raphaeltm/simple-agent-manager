import type { CredentialProvider } from '@simple-agent-manager/shared';

import { type GcpApiScope, pollGcpOperation } from './gcp-api';
import { fetchGcpMachineTypes, gcpOfferingsFromMachineTypes } from './gcp-catalog';
import { ensureGcpFirewallRules } from './gcp-firewall';
import {
  findGcpInstanceByIdOrName,
  getGcpInstanceInZone,
  listGcpInstances,
} from './gcp-instance-lookup';
import {
  COMPUTE_API_BASE,
  DEFAULT_GCP_AGENT_PORTS,
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  GCP_LOCATIONS,
  GCP_VOLUME_CAPABILITIES,
  type GcpTokenProvider,
  LOCATION_METADATA,
  SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
  SAM_NETWORK_TAG,
  SIZE_MAP,
  withGcpErrorCategory,
} from './gcp-metadata';
import { gcpInstanceToObservedVM, resolveGcpSourceImage } from './gcp-native-instance';
import type { GcpPriceTable } from './gcp-pricing';
import { getProviderCatalogOfferings } from './instance-offerings';
import { resolveVMConfigWithLegacySizeAdapter } from './native-vm-config';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  Provider,
  ProviderOfferingListOptions,
  ProviderRequestContext,
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
import { ProviderError } from './types';
import { parseProviderJson } from './validation';
import { type GcpInstancePayload, validateGcpOperation } from './validation-gcp';

export type { GcpTokenProvider } from './gcp-metadata';
export {
  classifyGcpError,
  DEFAULT_GCP_AGENT_PORTS,
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  DEFAULT_GCP_MAX_LIST_PAGES,
  GCP_LOCATIONS,
} from './gcp-metadata';

/** Live catalog inputs. Without them `listInstanceOfferings` returns the static table. */
export interface GcpCatalogOptions {
  /** Exact machine type names to offer (admin-editable). */
  machineTypes: readonly string[];
  /** Current list prices; null or a rejection leaves offerings unpriced. */
  priceTable?: () => Promise<GcpPriceTable | null>;
}

/**
 * GCP Compute Engine provider.
 *
 * Implements the Provider interface for GCP Compute Engine VMs.
 * Authentication is delegated to a `tokenProvider` function that returns
 * a valid GCP access token (obtained via STS token exchange at the API layer).
 */
export class GcpProvider implements Provider {
  readonly name = 'gcp';
  readonly locations = GCP_LOCATIONS;
  readonly locationMetadata = LOCATION_METADATA;
  readonly sizes = SIZE_MAP;
  readonly volumeCapabilities = GCP_VOLUME_CAPABILITIES;
  readonly defaultLocation: string;

  constructor(
    private readonly projectId: string,
    private readonly tokenProvider: GcpTokenProvider,
    defaultZone?: string,
    private readonly imageFamily: string = 'ubuntu-2404-lts-amd64',
    private readonly imageProject: string = 'ubuntu-os-cloud',
    private readonly diskSizeGb: number = 50,
    private readonly timeoutMs: number = 30_000,
    private readonly operationPollTimeoutMs: number = 5 * 60 * 1000,
    private readonly firewallSourceRanges: readonly string[] = DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
    private readonly agentPorts: readonly string[] = DEFAULT_GCP_AGENT_PORTS,
    private readonly appRouteSourceRanges: readonly string[] = DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
    private readonly appRoutePorts: readonly string[] = DEFAULT_GCP_APP_ROUTE_PORTS,
    private readonly catalog?: GcpCatalogOptions
  ) {
    this.defaultLocation = defaultZone || 'us-central1-a';
    this.instanceOfferingApiBacked = catalog !== undefined;
  }

  /** True when this instance was built with a live catalog (`GcpCatalogOptions`). */
  readonly instanceOfferingApiBacked: boolean;

  private async authHeaders(context?: ProviderRequestContext): Promise<Record<string, string>> {
    throwIfProviderRequestAborted(context);
    const token = context ? await this.tokenProvider(context) : await this.tokenProvider();
    throwIfProviderRequestAborted(context);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  private projectUrl(): string {
    return `${COMPUTE_API_BASE}/projects/${this.projectId}`;
  }

  /** Request scope for the shared helpers in `gcp-api.ts` / `gcp-firewall.ts`. */
  private get api(): GcpApiScope {
    return {
      projectUrl: this.projectUrl(),
      timeoutMs: this.timeoutMs,
      operationPollTimeoutMs: this.operationPollTimeoutMs,
      authHeaders: (context) => this.authHeaders(context),
    };
  }

  private pollOperation(
    zone: string,
    operationName: string,
    context?: ProviderRequestContext
  ): Promise<void> {
    return pollGcpOperation(
      this.api,
      `${this.projectUrl()}/zones/${zone}/operations/${operationName}`,
      { validationContext: 'pollOperation', timeoutSubject: 'GCP operation' },
      context
    );
  }

  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    try {
      return await this.createVMUnclassified(config, context);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      // Assign the category at construction (rule 72) so a zone stockout reaches the TaskRunner
      // as `transient_capacity` and descends the pool's fallback chain instead of failing.
      throw withGcpErrorCategory(err);
    }
  }

  private async createVMUnclassified(
    config: VMConfig,
    context?: ProviderRequestContext
  ): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const nativeConfig = resolveVMConfigWithLegacySizeAdapter(config, {
      providerName: this.name,
      defaultLocation: this.defaultLocation,
      legacySizes: this.sizes,
      defaultImage: this.imageFamily,
      defaultBootDiskSizeGb: this.diskSizeGb,
      minBootDiskSizeGb: 10,
      legacyBootDiskSizeAuthority: 'provider-default',
    });
    const zone = nativeConfig.location;
    const headers = await this.authHeaders(context);

    // Ensure firewall rules exist before creating VM
    await ensureGcpFirewallRules(
      this.api,
      {
        agentSourceRanges: this.firewallSourceRanges,
        agentPorts: this.agentPorts,
        appRouteSourceRanges: this.appRouteSourceRanges,
        appRoutePorts: this.appRoutePorts,
      },
      context
    );
    throwIfProviderRequestAborted(context);

    const networkTags = [SAM_NETWORK_TAG];
    if (nativeConfig.labels.role === 'deployment') {
      networkTags.push(SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG);
    }

    const body = {
      name: config.name,
      machineType: `zones/${zone}/machineTypes/${nativeConfig.instanceType}`,
      labels: {
        'sam-managed': 'true',
        ...nativeConfig.labels,
      },
      tags: {
        items: networkTags,
      },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: resolveGcpSourceImage(
              nativeConfig.image ?? this.imageFamily,
              this.imageProject
            ),
            diskSizeGb: String(nativeConfig.bootDiskSizeGb ?? this.diskSizeGb),
          },
        },
      ],
      networkInterfaces: [
        {
          network: 'global/networks/default',
          accessConfigs: [
            {
              type: 'ONE_TO_ONE_NAT',
              name: 'External NAT',
            },
          ],
        },
      ],
      serviceAccounts: [],
      metadata: {
        items: [
          {
            key: 'user-data',
            value: nativeConfig.userData,
          },
        ],
      },
    };

    const url = `${this.projectUrl()}/zones/${zone}/instances`;
    const res = await providerFetch(
      'gcp',
      url,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      },
      this.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);

    const op = validateGcpOperation(await parseProviderJson(res, 'gcp', 'createVM'), 'createVM', {
      requireName: true,
    });
    throwIfProviderRequestAborted(context);
    await this.pollOperation(zone, op.name, context);

    // Read the created instance from the zone it was created in, never by name project-wide.
    const created = await getGcpInstanceInZone(this.api, zone, config.name, context);
    const instance = created ? await gcpInstanceToObservedVM(this.api, created, context) : null;
    if (!instance) {
      throw new ProviderError(
        'gcp',
        undefined,
        `VM ${config.name} created but not found after polling`
      );
    }
    return instance;
  }

  async deleteVM(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    // GCP uses name-based lookups, so we need to find the zone
    const instance = await this.findInstanceByIdOrName(id, context);
    if (!instance) return; // Idempotent — already deleted

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders(context);
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}`;

    try {
      const res = await providerFetch(
        'gcp',
        url,
        { method: 'DELETE', headers },
        this.timeoutMs,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const op = validateGcpOperation(await parseProviderJson(res, 'gcp', 'deleteVM'), 'deleteVM', {
        requireName: true,
      });
      throwIfProviderRequestAborted(context);
      await this.pollOperation(zone, op.name, context);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) return;
      throw err;
    }
  }

  async getVM(id: string, context?: ProviderRequestContext): Promise<VMInstance | null> {
    throwIfProviderRequestAborted(context);
    const instance = await this.findInstanceByIdOrName(id, context);
    if (!instance) return null;
    // With observed hardware: durable allocation recovery adopts a VM whose create response
    // was cut off, and verifies its native hardware against the persisted plan
    // (apps/api node-allocation-recovery.ts). One extra machineTypes.get per call.
    return gcpInstanceToObservedVM(this.api, instance, context);
  }

  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    return listGcpInstances(this.api, labels, context);
  }

  async powerOff(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const instance = await this.findInstanceByIdOrName(id, context);
    if (!instance) throw new ProviderError('gcp', 404, `VM ${id} not found`);

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders(context);
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}/stop`;
    const res = await providerFetch(
      'gcp',
      url,
      { method: 'POST', headers },
      this.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const op = validateGcpOperation(await parseProviderJson(res, 'gcp', 'powerOff'), 'powerOff', {
      requireName: true,
    });
    throwIfProviderRequestAborted(context);
    await this.pollOperation(zone, op.name, context);
  }

  async powerOn(id: string, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    const instance = await this.findInstanceByIdOrName(id, context);
    if (!instance) throw new ProviderError('gcp', 404, `VM ${id} not found`);

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders(context);
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}/start`;
    const res = await providerFetch(
      'gcp',
      url,
      { method: 'POST', headers },
      this.timeoutMs,
      undefined,
      context
    );
    throwIfProviderRequestAborted(context);
    const op = validateGcpOperation(await parseProviderJson(res, 'gcp', 'powerOn'), 'powerOn', {
      requireName: true,
    });
    throwIfProviderRequestAborted(context);
    await this.pollOperation(zone, op.name, context);
  }

  async validateToken(context?: ProviderRequestContext): Promise<boolean> {
    throwIfProviderRequestAborted(context);
    const headers = await this.authHeaders(context);
    // Try a lightweight API call to verify credentials
    const url = `${this.projectUrl()}/zones/${this.defaultLocation}/machineTypes/e2-standard-2`;
    await providerFetch('gcp', url, { headers }, this.timeoutMs, undefined, context);
    throwIfProviderRequestAborted(context);
    return true;
  }

  async listInstanceOfferings(
    options?: ProviderOfferingListOptions,
    context?: ProviderRequestContext
  ) {
    throwIfProviderRequestAborted(context);
    if (options?.preferApi === false || !this.catalog) return this.staticOfferings();
    try {
      const [types, priceTable] = await Promise.all([
        fetchGcpMachineTypes(this.api, this.catalog.machineTypes, context),
        this.loadPriceTable(),
      ]);
      throwIfProviderRequestAborted(context);
      return gcpOfferingsFromMachineTypes(types, priceTable, {
        bootDiskGb: this.diskSizeGb,
        lastSeenAt: new Date().toISOString(),
      });
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (options?.allowStaticFallback === false) throw err;
      return this.staticOfferings();
    }
  }

  private staticOfferings() {
    return getProviderCatalogOfferings(
      this.name as CredentialProvider,
      this.locations,
      this.locationMetadata
    );
  }

  /** Prices are optional: an unavailable table leaves offerings unpriced, never fails them. */
  private async loadPriceTable(): Promise<GcpPriceTable | null> {
    if (!this.catalog?.priceTable) return null;
    try {
      return await this.catalog.priceTable();
    } catch {
      return null;
    }
  }

  async createVolume(
    _config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('createVolume');
  }

  async attachVolume(
    _config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('attachVolume');
  }

  async detachVolume(
    _config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('detachVolume');
  }

  async resizeVolume(
    _config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('resizeVolume');
  }

  async deleteVolume(_config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('deleteVolume');
  }

  async getVolume(
    _config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('getVolume');
  }

  async listVolumes(
    _config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    throw this.unsupportedVolumeOperation('listVolumes');
  }

  /**
   * Find a GCP instance by numeric ID or name across all configured zones.
   */
  private findInstanceByIdOrName(
    idOrName: string,
    context?: ProviderRequestContext
  ): Promise<GcpInstancePayload | null> {
    return findGcpInstanceByIdOrName(this.api, this.locations, idOrName, context);
  }

  private unsupportedVolumeOperation(operation: string): ProviderError {
    return new ProviderError(
      this.name,
      undefined,
      `GCP provider does not support volume operation ${operation}`,
      { category: 'invalid_config' }
    );
  }

  /** Extract zone from a machineType URL like zones/us-central1-a/machineTypes/e2-standard-2 */
  private extractZone(machineType: string): string {
    const match = machineType.match(/zones\/([^/]+)/);
    return match?.[1] || this.defaultLocation;
  }
}
