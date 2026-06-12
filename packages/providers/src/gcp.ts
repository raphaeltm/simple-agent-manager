import type { VMSize } from '@simple-agent-manager/shared';

import { CLOUDFLARE_IPV4_RANGES } from './cloudflare-ranges';
import { providerFetch } from './provider-fetch';
import type {
  LocationMeta,
  Provider,
  ProviderErrorCategory,
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
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import {
  type GcpInstancePayload,
  type GcpNetworkInterfacePayload,
  parseProviderJson,
  validateGcpAggregatedInstances,
  validateGcpInstance,
  validateGcpInstancesList,
  validateGcpOperation,
} from './validation';

const COMPUTE_API_BASE = 'https://compute.googleapis.com/compute/v1';

/**
 * Classify a GCP API error into a normalized ProviderErrorCategory.
 *
 * GCP error responses use `{ error: { code, status, errors: [...] } }` where
 * `status` is the structured signal (e.g., "RESOURCE_EXHAUSTED", "UNAVAILABLE").
 * The `providerCode` in ProviderError corresponds to the `error.status` field.
 *
 * GCP error statuses (from API docs):
 * - RESOURCE_EXHAUSTED → quota_exceeded (429)
 * - UNAVAILABLE → transient_capacity (503)
 * - ZONE_RESOURCE_POOL_EXHAUSTED → transient_capacity
 * - ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS → transient_capacity
 * - QUOTA_EXCEEDED → quota_exceeded
 * - PERMISSION_DENIED → auth_error
 * - UNAUTHENTICATED → auth_error
 * - INVALID_ARGUMENT → invalid_config
 * - NOT_FOUND → invalid_config
 * - ALREADY_EXISTS → invalid_config
 * - RATE_LIMIT_EXCEEDED → rate_limited
 */
export function classifyGcpError(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string,
): ProviderErrorCategory {
  if (providerCode) {
    switch (providerCode) {
      case 'UNAVAILABLE':
      case 'ZONE_RESOURCE_POOL_EXHAUSTED':
      case 'ZONE_RESOURCE_POOL_EXHAUSTED_WITH_DETAILS':
        return 'transient_capacity';
      case 'RESOURCE_EXHAUSTED':
      case 'QUOTA_EXCEEDED':
        return 'quota_exceeded';
      case 'PERMISSION_DENIED':
      case 'UNAUTHENTICATED':
        return 'auth_error';
      case 'INVALID_ARGUMENT':
      case 'NOT_FOUND':
      case 'ALREADY_EXISTS':
        return 'invalid_config';
      case 'RATE_LIMIT_EXCEEDED':
        return 'rate_limited';
    }
  }

  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'transient_capacity';

  // Message-based fallback (order matters: check zone-specific before general)
  if (/zone.*resource.*pool.*exhausted/i.test(message)) return 'transient_capacity';
  if (/resource.*exhausted|quota/i.test(message)) return 'quota_exceeded';

  return 'unknown';
}

/** Firewall rule names and config for SAM inbound access. */
const SAM_AGENT_FIREWALL_RULE_NAME = 'sam-allow-agent';
const SAM_APP_ROUTE_FIREWALL_RULE_NAME = 'sam-allow-app-routes';
const SAM_NETWORK_TAG = 'sam-agent';
const SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG = 'sam-deployment-app-routes';
/** Default ports the VM agent may listen on (8443 with TLS, 8080 without). */
export const DEFAULT_GCP_AGENT_PORTS = ['8080', '8443'] as const;
/** Default public ports served directly by deployment-node Caddy app routes. */
export const DEFAULT_GCP_APP_ROUTE_PORTS = ['80', '443'] as const;
/**
 * Default GCP project firewall source ranges. These mirror Cloudflare's IPv4
 * edge ranges so the VPC firewall and VM cloud-init firewall both restrict
 * agent ingress to Cloudflare-routed traffic by default.
 */
export const DEFAULT_GCP_FIREWALL_SOURCE_RANGES = CLOUDFLARE_IPV4_RANGES;
/** Default source ranges for grey-cloud app routes and HTTP-01 ACME. */
export const DEFAULT_GCP_APP_ROUTE_SOURCE_RANGES = ['0.0.0.0/0'] as const;

/** GCP machine type mappings for SAM VM sizes */
const SIZE_MAP: Record<VMSize, SizeConfig> = {
  small: { type: 'e2-medium', price: '~$25/mo', vcpu: 1, ramGb: 4, storageGb: 50 },
  medium: { type: 'e2-standard-2', price: '~$49/mo', vcpu: 2, ramGb: 8, storageGb: 50 },
  large: { type: 'e2-standard-4', price: '~$97/mo', vcpu: 4, ramGb: 16, storageGb: 50 },
};

/** Available GCP zones */
export const GCP_LOCATIONS = [
  'us-central1-a',
  'us-east1-b',
  'us-west1-a',
  'europe-west1-b',
  'europe-west3-a',
  'europe-west2-a',
  'asia-southeast1-a',
  'asia-northeast1-a',
] as const;

const LOCATION_METADATA: Record<string, LocationMeta> = {
  'us-central1-a': { name: 'Iowa', country: 'US' },
  'us-east1-b': { name: 'South Carolina', country: 'US' },
  'us-west1-a': { name: 'Oregon', country: 'US' },
  'europe-west1-b': { name: 'Belgium', country: 'BE' },
  'europe-west3-a': { name: 'Frankfurt', country: 'DE' },
  'europe-west2-a': { name: 'London', country: 'GB' },
  'asia-southeast1-a': { name: 'Singapore', country: 'SG' },
  'asia-northeast1-a': { name: 'Tokyo', country: 'JP' },
};

const GCP_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: false,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: ['GCP first-class persistent disk operations are not implemented in this provider package yet.'],
};

/** Map GCP instance status to SAM VMStatus */
function mapGcpStatus(status: string): VMInstance['status'] {
  switch (status) {
    case 'PROVISIONING':
    case 'STAGING':
      return 'initializing';
    case 'RUNNING':
      return 'running';
    case 'STOPPING':
      return 'stopping';
    case 'STOPPED':
    case 'TERMINATED':
    case 'SUSPENDING':
    case 'SUSPENDED':
      return 'off';
    default:
      return 'initializing';
  }
}

/** Extract IP from GCP network interfaces */
function extractIp(networkInterfaces?: GcpNetworkInterfacePayload[]): string {
  if (!networkInterfaces?.length) return '';
  const accessConfigs = networkInterfaces[0]?.accessConfigs;
  if (!accessConfigs?.length) return '';
  return accessConfigs[0]?.natIP || '';
}

/**
 * Function type for providing GCP access tokens.
 * The GCP provider doesn't handle token exchange directly —
 * callers provide a function that returns a valid access token.
 */
export type GcpTokenProvider = () => Promise<string>;

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
  ) {
    this.defaultLocation = defaultZone || 'us-central1-a';
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.tokenProvider();
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
  private async pollOperation(zone: string, operationName: string): Promise<void> {
    const deadline = Date.now() + this.operationPollTimeoutMs;
    let delayMs = 1000;
    const maxDelayMs = 30_000;

    while (Date.now() < deadline) {
      const headers = await this.authHeaders();
      const url = `${this.projectUrl()}/zones/${zone}/operations/${operationName}`;
      const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'pollOperation'),
        'pollOperation',
      );

      if (op.status === 'DONE') {
        if (op.error?.errors?.length) {
          const errMsg = op.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          throw new ProviderError('gcp', undefined, `GCP operation failed: ${errMsg}`);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    throw new ProviderError('gcp', undefined, `GCP operation timed out after ${this.operationPollTimeoutMs}ms`);
  }

  private async ensureFirewallRule(
    name: string,
    ports: readonly string[],
    sourceRanges: readonly string[],
    description: string,
    targetTag: string,
  ): Promise<void> {
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/global/firewalls`;

    const body = {
      name,
      network: `${this.projectUrl()}/global/networks/default`,
      direction: 'INGRESS',
      priority: 1000,
      targetTags: [targetTag],
      allowed: [
        {
          IPProtocol: 'tcp',
          ports: [...ports],
        },
      ],
      sourceRanges: [...sourceRanges],
      description,
    };

    try {
      const res = await providerFetch('gcp', url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, this.timeoutMs);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'ensureFirewallRule'),
        'ensureFirewallRule',
        { requireName: true },
      );
      // Firewall operations are global, poll via global operations endpoint
      await this.pollGlobalOperation(op.name);
    } catch (err) {
      // 409 = already exists — that's fine
      if (err instanceof ProviderError && err.statusCode === 409) return;
      throw err;
    }
  }

  /**
   * Ensure firewall rules for both Cloudflare-routed VM-agent traffic and
   * direct public app-route traffic served by Caddy.
   */
  private async ensureFirewallRules(): Promise<void> {
    await this.ensureFirewallRule(
      SAM_AGENT_FIREWALL_RULE_NAME,
      this.agentPorts,
      this.firewallSourceRanges,
      'Allow configured inbound access to SAM VM agent (managed by Simple Agent Manager)',
      SAM_NETWORK_TAG,
    );
    await this.ensureFirewallRule(
      SAM_APP_ROUTE_FIREWALL_RULE_NAME,
      this.appRoutePorts,
      this.appRouteSourceRanges,
      'Allow public HTTP/HTTPS access to SAM deployment app routes (managed by Simple Agent Manager)',
      SAM_DEPLOYMENT_APP_ROUTE_NETWORK_TAG,
    );
  }

  /**
   * Poll a global operation (used for firewall rules which are not zone-scoped).
   */
  private async pollGlobalOperation(operationName: string): Promise<void> {
    const deadline = Date.now() + this.operationPollTimeoutMs;
    let delayMs = 1000;
    const maxDelayMs = 30_000;

    while (Date.now() < deadline) {
      const headers = await this.authHeaders();
      const url = `${this.projectUrl()}/global/operations/${operationName}`;
      const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'pollGlobalOperation'),
        'pollGlobalOperation',
      );

      if (op.status === 'DONE') {
        if (op.error?.errors?.length) {
          const errMsg = op.error.errors.map((e) => `${e.code}: ${e.message}`).join('; ');
          throw new ProviderError('gcp', undefined, `GCP operation failed: ${errMsg}`);
        }
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, maxDelayMs);
    }

    throw new ProviderError('gcp', undefined, `GCP global operation timed out after ${this.operationPollTimeoutMs}ms`);
  }

  async createVM(config: VMConfig): Promise<VMInstance> {
    const zone = config.location || this.defaultLocation;
    const sizeConfig = SIZE_MAP[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }
    const machineType = sizeConfig.type;
    const headers = await this.authHeaders();

    // Ensure firewall rules exist before creating VM
    await this.ensureFirewallRules();

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
    const res = await providerFetch('gcp', url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }, this.timeoutMs);

    const op = validateGcpOperation(
      await parseProviderJson(res, 'gcp', 'createVM'),
      'createVM',
      { requireName: true },
    );
    await this.pollOperation(zone, op.name);

    // Fetch the created instance to get its details
    const instance = await this.getVM(config.name);
    if (!instance) {
      throw new ProviderError('gcp', undefined, `VM ${config.name} created but not found after polling`);
    }
    return instance;
  }

  async deleteVM(id: string): Promise<void> {
    // GCP uses name-based lookups, so we need to find the zone
    const instance = await this.findInstanceByIdOrName(id);
    if (!instance) return; // Idempotent — already deleted

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}`;

    try {
      const res = await providerFetch('gcp', url, { method: 'DELETE', headers }, this.timeoutMs);
      const op = validateGcpOperation(
        await parseProviderJson(res, 'gcp', 'deleteVM'),
        'deleteVM',
        { requireName: true },
      );
      await this.pollOperation(zone, op.name);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) return;
      throw err;
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    const instance = await this.findInstanceByIdOrName(id);
    if (!instance) return null;
    return this.toVMInstance(instance);
  }

  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const headers = await this.authHeaders();
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
      try {
        const url = `${this.projectUrl()}/zones/${zone}/instances?filter=${encodeURIComponent(filterStr)}`;
        const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
        const data = validateGcpInstancesList(
          await parseProviderJson(res, 'gcp', `listVMs.${zone}`),
          `listVMs.${zone}`,
        );
        results.push(...(data.items || []).map((i) => this.toVMInstance(i)));
      } catch (err) {
        if (this.isToleratedZoneListError(err)) continue;
        throw new ProviderError(
          'gcp',
          err instanceof ProviderError ? err.statusCode : undefined,
          `GCP zone ${zone} list failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err instanceof Error ? err : undefined },
        );
      }
    }

    return results;
  }

  async powerOff(id: string): Promise<void> {
    const instance = await this.findInstanceByIdOrName(id);
    if (!instance) throw new ProviderError('gcp', 404, `VM ${id} not found`);

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}/stop`;
    const res = await providerFetch('gcp', url, { method: 'POST', headers }, this.timeoutMs);
    const op = validateGcpOperation(
      await parseProviderJson(res, 'gcp', 'powerOff'),
      'powerOff',
      { requireName: true },
    );
    await this.pollOperation(zone, op.name);
  }

  async powerOn(id: string): Promise<void> {
    const instance = await this.findInstanceByIdOrName(id);
    if (!instance) throw new ProviderError('gcp', 404, `VM ${id} not found`);

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}/start`;
    const res = await providerFetch('gcp', url, { method: 'POST', headers }, this.timeoutMs);
    const op = validateGcpOperation(
      await parseProviderJson(res, 'gcp', 'powerOn'),
      'powerOn',
      { requireName: true },
    );
    await this.pollOperation(zone, op.name);
  }

  async validateToken(): Promise<boolean> {
    const headers = await this.authHeaders();
    // Try a lightweight API call to verify credentials
    const url = `${this.projectUrl()}/zones/${this.defaultLocation}/machineTypes/e2-standard-2`;
    await providerFetch('gcp', url, { headers }, this.timeoutMs);
    return true;
  }

  createVolume(_config: VolumeConfig): Promise<VolumeInstance> {
    return Promise.reject(this.unsupportedVolumeOperation('createVolume'));
  }

  attachVolume(_config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    return Promise.reject(this.unsupportedVolumeOperation('attachVolume'));
  }

  detachVolume(_config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    return Promise.reject(this.unsupportedVolumeOperation('detachVolume'));
  }

  resizeVolume(_config: VolumeResizeConfig): Promise<VolumeInstance> {
    return Promise.reject(this.unsupportedVolumeOperation('resizeVolume'));
  }

  deleteVolume(_config: VolumeLookupConfig): Promise<void> {
    return Promise.reject(this.unsupportedVolumeOperation('deleteVolume'));
  }

  getVolume(_config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    return Promise.reject(this.unsupportedVolumeOperation('getVolume'));
  }

  listVolumes(_config: VolumeListConfig): Promise<VolumeInstance[]> {
    return Promise.reject(this.unsupportedVolumeOperation('listVolumes'));
  }

  /**
   * Find a GCP instance by numeric ID or name across all configured zones.
   */
  private async findInstanceByIdOrName(idOrName: string): Promise<GcpInstancePayload | null> {
    const headers = await this.authHeaders();

    // First try as a name in each zone
    for (const zone of this.locations) {
      try {
        const url = `${this.projectUrl()}/zones/${zone}/instances/${idOrName}`;
        const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
        return validateGcpInstance(
          await parseProviderJson(res, 'gcp', `findInstanceByIdOrName.${zone}`),
          `findInstanceByIdOrName.${zone}`,
        );
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 404) continue;
        throw err;
      }
    }

    // If not found by name, try aggregated list with filter by label
    try {
      const filterStr = `labels.sam-managed=true`;
      const url = `${COMPUTE_API_BASE}/projects/${this.projectId}/aggregated/instances?filter=${encodeURIComponent(filterStr)}`;
      const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
      const data = validateGcpAggregatedInstances(
        await parseProviderJson(res, 'gcp', 'findInstanceByIdOrName.aggregated'),
        'findInstanceByIdOrName.aggregated',
      );
      if (data.items) {
        for (const scopeData of Object.values(data.items)) {
          for (const instance of scopeData.instances || []) {
            if (instance.id === idOrName || instance.name === idOrName) {
              return instance;
            }
          }
        }
      }
    } catch (err) {
      throw new ProviderError(
        'gcp',
        err instanceof ProviderError ? err.statusCode : undefined,
        `GCP aggregated instance lookup failed for ${idOrName}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    return null;
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
    return err instanceof ProviderError
      && (err.statusCode === 404 || err.statusCode === 503);
  }

  private unsupportedVolumeOperation(operation: string): ProviderError {
    return new ProviderError(
      this.name,
      undefined,
      `GCP provider does not support volume operation ${operation}`,
      { category: 'invalid_config' },
    );
  }

  /** Extract zone from a machineType URL like zones/us-central1-a/machineTypes/e2-standard-2 */
  private extractZone(machineType: string): string {
    const match = machineType.match(/zones\/([^/]+)/);
    return match?.[1] || this.defaultLocation;
  }
}
