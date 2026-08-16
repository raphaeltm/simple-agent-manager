import {
  COMPUTE_API_BASE,
  DEFAULT_GCP_AGENT_PORTS,
  DEFAULT_GCP_APP_ROUTE_PORTS,
  DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES,
  DEFAULT_GCP_FIREWALL_SOURCE_RANGES,
  DEFAULT_GCP_MAX_LIST_PAGES,
  extractIp,
  GCP_LOCATIONS,
  GCP_VOLUME_CAPABILITIES,
  type GcpTokenProvider,
  LOCATION_METADATA,
  mapGcpStatus,
  SAM_AGENT_FIREWALL_RULE_NAME,
  SAM_APP_ROUTE_FIREWALL_RULE_NAME,
  SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
  SAM_NETWORK_TAG,
  SIZE_MAP,
} from './gcp-metadata';
import {
  providerDelay,
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  Provider,
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
import {
  type GcpInstancePayload,
  parseProviderJson,
  validateGcpAggregatedInstances,
  validateGcpInstance,
  validateGcpInstancesList,
  validateGcpOperation,
} from './validation';

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
    private readonly appRoutePorts: readonly string[] = DEFAULT_GCP_APP_ROUTE_PORTS
  ) {
    this.defaultLocation = defaultZone || 'us-central1-a';
  }

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

  /**
   * Poll a zonal operation until it completes or times out.
   */
  private async pollOperation(
    zone: string,
    operationName: string,
    context?: ProviderRequestContext
  ): Promise<void> {
    const deadline = Date.now() + this.operationPollTimeoutMs;
    let delayMs = 1000;
    const maxDelayMs = 30_000;

    while (Date.now() < deadline) {
      throwIfProviderRequestAborted(context);
      const headers = await this.authHeaders(context);
      const url = `${this.projectUrl()}/zones/${zone}/operations/${operationName}`;
      const res = await providerFetch('gcp', url, { headers }, this.timeoutMs, undefined, context);
      throwIfProviderRequestAborted(context);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'pollOperation'),
        'pollOperation'
      );
      throwIfProviderRequestAborted(context);

      if (op.status === 'DONE') {
        if (op.error?.errors?.length) {
          const errMsg = op.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          throw new ProviderError('gcp', undefined, `GCP operation failed: ${errMsg}`);
        }
        return;
      }

      await providerDelay(delayMs, context);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    throw new ProviderError(
      'gcp',
      undefined,
      `GCP operation timed out after ${this.operationPollTimeoutMs}ms`
    );
  }

  private async ensureFirewallRule(
    name: string,
    ports: readonly string[],
    sourceRanges: readonly string[],
    description: string,
    targetTag: string,
    context?: ProviderRequestContext
  ): Promise<void> {
    throwIfProviderRequestAborted(context);
    const headers = await this.authHeaders(context);
    const url = `${this.projectUrl()}/global/firewalls`;

    try {
      const res = await providerFetch(
        'gcp',
        url,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(
            this.buildFirewallRuleBody(name, ports, sourceRanges, description, targetTag)
          ),
        },
        this.timeoutMs,
        undefined,
        context
      );
      throwIfProviderRequestAborted(context);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'ensureFirewallRule'),
        'ensureFirewallRule',
        { requireName: true }
      );
      throwIfProviderRequestAborted(context);
      // Firewall operations are global, poll via global operations endpoint
      await this.pollGlobalOperation(op.name, context);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      // 409 = already exists — that's fine
      if (err instanceof ProviderError && err.statusCode === 409) return;
      throw err;
    }
  }

  private buildFirewallRuleBody(
    name: string,
    ports: readonly string[],
    sourceRanges: readonly string[],
    description: string,
    targetTag: string
  ) {
    return {
      name,
      network: `${this.projectUrl()}/global/networks/default`,
      direction: 'INGRESS',
      priority: 1000,
      targetTags: [targetTag],
      allowed: [{ IPProtocol: 'tcp', ports: [...ports] }],
      sourceRanges: [...sourceRanges],
      description,
    };
  }

  /**
   * Ensure firewall rules for both Cloudflare-routed VM-agent traffic and
   * direct public app-route traffic served by Caddy.
   */
  private async ensureFirewallRules(context?: ProviderRequestContext): Promise<void> {
    await this.ensureFirewallRule(
      SAM_AGENT_FIREWALL_RULE_NAME,
      this.agentPorts,
      this.firewallSourceRanges,
      'Allow configured inbound access to SAM VM agent (managed by Simple Agent Manager)',
      SAM_NETWORK_TAG,
      context
    );
    throwIfProviderRequestAborted(context);
    await this.ensureFirewallRule(
      SAM_APP_ROUTE_FIREWALL_RULE_NAME,
      this.appRoutePorts,
      this.appRouteSourceRanges,
      'Allow public HTTP/HTTPS access to SAM deployment app routes (managed by Simple Agent Manager)',
      SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
      context
    );
  }

  /**
   * Poll a global operation (used for firewall rules which are not zone-scoped).
   */
  private async pollGlobalOperation(
    operationName: string,
    context?: ProviderRequestContext
  ): Promise<void> {
    const deadline = Date.now() + this.operationPollTimeoutMs;
    let delayMs = 1000;
    const maxDelayMs = 30_000;

    while (Date.now() < deadline) {
      throwIfProviderRequestAborted(context);
      const headers = await this.authHeaders(context);
      const url = `${this.projectUrl()}/global/operations/${operationName}`;
      const res = await providerFetch('gcp', url, { headers }, this.timeoutMs, undefined, context);
      throwIfProviderRequestAborted(context);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'pollGlobalOperation'),
        'pollGlobalOperation'
      );
      throwIfProviderRequestAborted(context);

      if (op.status === 'DONE') {
        if (op.error?.errors?.length) {
          const errMsg = op.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          throw new ProviderError('gcp', undefined, `GCP operation failed: ${errMsg}`);
        }
        return;
      }

      await providerDelay(delayMs, context);
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    throw new ProviderError(
      'gcp',
      undefined,
      `GCP global operation timed out after ${this.operationPollTimeoutMs}ms`
    );
  }

  async createVM(config: VMConfig, context?: ProviderRequestContext): Promise<VMInstance> {
    throwIfProviderRequestAborted(context);
    const zone = config.location || this.defaultLocation;
    const sizeConfig = SIZE_MAP[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }
    const machineType = sizeConfig.type;
    const headers = await this.authHeaders(context);

    // Ensure firewall rules exist before creating VM
    await this.ensureFirewallRules(context);
    throwIfProviderRequestAborted(context);

    const networkTags = [SAM_NETWORK_TAG];
    if (config.labels?.role === 'deployment') {
      networkTags.push(SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG);
    }

    const body = {
      name: config.name,
      machineType: `zones/${zone}/machineTypes/${machineType}`,
      labels: {
        'sam-managed': 'true',
        ...(config.labels || {}),
      },
      tags: {
        items: networkTags,
      },
      disks: [
        {
          boot: true,
          autoDelete: true,
          initializeParams: {
            sourceImage: `projects/${this.imageProject}/global/images/family/${this.imageFamily}`,
            diskSizeGb: String(this.diskSizeGb),
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
            value: config.userData,
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

    // Fetch the created instance to get its details
    const instance = await this.getVM(config.name, context);
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
    return this.toVMInstance(instance);
  }

  async listVMs(
    labels?: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<VMInstance[]> {
    throwIfProviderRequestAborted(context);
    const headers = await this.authHeaders(context);
    const results: VMInstance[] = [];

    // Build filter from labels
    const filters: string[] = ['labels.sam-managed=true'];
    if (labels) {
      for (const [key, value] of Object.entries(labels)) {
        filters.push(`labels.${key}=${value}`);
      }
    }
    const filterStr = filters.join(' ');

    // Query all configured zones
    for (const zone of this.locations) {
      throwIfProviderRequestAborted(context);
      try {
        await this.fetchPaginatedGcpInstances(
          `${this.projectUrl()}/zones/${zone}/instances`,
          new URLSearchParams({ filter: filterStr }),
          headers,
          `listVMs.${zone}`,
          (data) => {
            results.push(...(data.items || []).map((i) => this.toVMInstance(i)));
          },
          context
        );
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
        if (this.isToleratedZoneListError(err)) continue;
        throw new ProviderError(
          'gcp',
          err instanceof ProviderError ? err.statusCode : undefined,
          `GCP zone ${zone} list failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err instanceof Error ? err : undefined }
        );
      }
    }

    return results;
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
  private async findInstanceByIdOrName(
    idOrName: string,
    context?: ProviderRequestContext
  ): Promise<GcpInstancePayload | null> {
    throwIfProviderRequestAborted(context);
    const headers = await this.authHeaders(context);
    const namedInstance = await this.findNamedInstance(idOrName, headers, context);
    if (namedInstance) return namedInstance;
    return await this.findAggregatedInstance(idOrName, headers, context);
  }

  private async findNamedInstance(
    idOrName: string,
    headers: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<GcpInstancePayload | null> {
    for (const zone of this.locations) {
      throwIfProviderRequestAborted(context);
      try {
        const url = `${this.projectUrl()}/zones/${zone}/instances/${idOrName}`;
        const res = await providerFetch(
          'gcp',
          url,
          { headers },
          this.timeoutMs,
          undefined,
          context
        );
        throwIfProviderRequestAborted(context);
        const instance = validateGcpInstance(
          await parseProviderJson(res, 'gcp', `findInstanceByIdOrName.${zone}`),
          `findInstanceByIdOrName.${zone}`
        );
        throwIfProviderRequestAborted(context);
        return instance;
      } catch (err) {
        rethrowIfProviderRequestAborted(err, context);
        if (err instanceof ProviderError && err.statusCode === 404) continue;
        throw err;
      }
    }
    return null;
  }

  private async findAggregatedInstance(
    idOrName: string,
    headers: Record<string, string>,
    context?: ProviderRequestContext
  ): Promise<GcpInstancePayload | null> {
    try {
      const filterStr = `labels.sam-managed=true`;
      let found: GcpInstancePayload | null = null;
      await this.fetchPaginatedGcpAggregatedInstances(
        `${COMPUTE_API_BASE}/projects/${this.projectId}/aggregated/instances`,
        new URLSearchParams({ filter: filterStr }),
        headers,
        'findInstanceByIdOrName.aggregated',
        (data) => {
          if (found || !data.items) return;
          for (const scopeData of Object.values(data.items)) {
            for (const instance of scopeData.instances || []) {
              if (instance.id === idOrName || instance.name === idOrName) {
                found = instance;
                return true;
              }
            }
          }
        },
        context
      );
      if (found) return found;
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      throw new ProviderError(
        'gcp',
        err instanceof ProviderError ? err.statusCode : undefined,
        `GCP aggregated instance lookup failed for ${idOrName}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined }
      );
    }

    return null;
  }

  private async fetchPaginatedGcpInstances(
    baseUrl: string,
    baseParams: URLSearchParams,
    headers: Record<string, string>,
    context: string,
    handlePage: (data: { items?: GcpInstancePayload[]; nextPageToken?: string }) => boolean | void,
    requestContext?: ProviderRequestContext
  ): Promise<void> {
    await this.fetchPaginatedGcpList(
      baseUrl,
      baseParams,
      headers,
      context,
      async (payload) => {
        const data = validateGcpInstancesList(payload, context);
        const stop = handlePage(data);
        return { nextPageToken: data.nextPageToken, stop: stop === true };
      },
      requestContext
    );
  }

  private async fetchPaginatedGcpAggregatedInstances(
    baseUrl: string,
    baseParams: URLSearchParams,
    headers: Record<string, string>,
    context: string,
    handlePage: (data: {
      items?: Record<string, { instances?: GcpInstancePayload[] }>;
      nextPageToken?: string;
    }) => boolean | void,
    requestContext?: ProviderRequestContext
  ): Promise<void> {
    await this.fetchPaginatedGcpList(
      baseUrl,
      baseParams,
      headers,
      context,
      async (payload) => {
        const data = validateGcpAggregatedInstances(payload, context);
        const stop = handlePage(data);
        return { nextPageToken: data.nextPageToken, stop: stop === true };
      },
      requestContext
    );
  }

  private async fetchPaginatedGcpList(
    baseUrl: string,
    baseParams: URLSearchParams,
    headers: Record<string, string>,
    context: string,
    handlePage: (payload: unknown) => Promise<{ nextPageToken?: string; stop?: boolean }>,
    requestContext?: ProviderRequestContext
  ): Promise<void> {
    const seenTokens = new Set<string>();
    let pageToken: string | undefined;

    for (let pageCount = 0; pageCount < DEFAULT_GCP_MAX_LIST_PAGES; pageCount += 1) {
      throwIfProviderRequestAborted(requestContext);
      const params = new URLSearchParams(baseParams);
      if (pageToken) params.set('pageToken', pageToken);
      const res = await providerFetch(
        'gcp',
        `${baseUrl}?${params.toString()}`,
        { headers },
        this.timeoutMs,
        undefined,
        requestContext
      );
      throwIfProviderRequestAborted(requestContext);
      const result = await handlePage(await parseProviderJson(res, 'gcp', context));
      throwIfProviderRequestAborted(requestContext);
      if (result.stop || !result.nextPageToken) return;
      if (seenTokens.has(result.nextPageToken)) {
        throw new ProviderError(
          'gcp',
          undefined,
          `GCP ${context} pagination repeated nextPageToken`,
          {
            category: 'invalid_config',
          }
        );
      }
      seenTokens.add(result.nextPageToken);
      pageToken = result.nextPageToken;
    }

    throw new ProviderError(
      'gcp',
      undefined,
      `GCP ${context} exceeded ${DEFAULT_GCP_MAX_LIST_PAGES} pages`,
      {
        category: 'invalid_config',
      }
    );
  }

  private toVMInstance(instance: GcpInstancePayload): VMInstance {
    return {
      id: instance.id || instance.name,
      name: instance.name,
      ip: extractIp(instance.networkInterfaces),
      status: mapGcpStatus(instance.status),
      serverType: instance.machineType.split('/').pop() || instance.machineType,
      createdAt: instance.creationTimestamp,
      labels: instance.labels || {},
    };
  }

  private isToleratedZoneListError(err: unknown): boolean {
    return err instanceof ProviderError && (err.statusCode === 404 || err.statusCode === 503);
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
