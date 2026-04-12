import type { VMSize } from '@simple-agent-manager/shared';

import { providerFetch } from './provider-fetch';
import type { LocationMeta,Provider, SizeConfig, VMConfig, VMInstance } from './types';
import { ProviderError } from './types';

const COMPUTE_API_BASE = 'https://compute.googleapis.com/compute/v1';

/** Firewall rule name and config for SAM VM agent inbound access */
const SAM_FIREWALL_RULE_NAME = 'sam-allow-agent';
const SAM_NETWORK_TAG = 'sam-agent';
/** Ports the VM agent may listen on (8443 with TLS, 8080 without) */
const SAM_AGENT_PORTS = ['8080', '8443'];

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
function extractIp(networkInterfaces?: GcpNetworkInterface[]): string {
  if (!networkInterfaces?.length) return '';
  const accessConfigs = networkInterfaces[0]?.accessConfigs;
  if (!accessConfigs?.length) return '';
  return accessConfigs[0]?.natIP || '';
}

/** Interface for GCP operation polling */
interface GcpOperation {
  name: string;
  status: string;
  error?: { errors?: Array<{ code: string; message: string }> };
}

interface GcpNetworkInterface {
  accessConfigs?: Array<{ natIP?: string }>;
}

interface GcpInstance {
  id: string;
  name: string;
  status: string;
  machineType: string;
  creationTimestamp: string;
  labels?: Record<string, string>;
  networkInterfaces?: GcpNetworkInterface[];
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
      const op = (await res.json()) as GcpOperation;

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

  /**
   * Ensure a firewall rule exists allowing inbound TCP on SAM agent ports.
   * Idempotent — skips creation if the rule already exists (409).
   */
  private async ensureFirewallRule(): Promise<void> {
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/global/firewalls`;

    const body = {
      name: SAM_FIREWALL_RULE_NAME,
      network: `${this.projectUrl()}/global/networks/default`,
      direction: 'INGRESS',
      priority: 1000,
      targetTags: [SAM_NETWORK_TAG],
      allowed: [
        {
          IPProtocol: 'tcp',
          ports: SAM_AGENT_PORTS,
        },
      ],
      sourceRanges: ['0.0.0.0/0'],
      description: 'Allow inbound access to SAM VM agent (managed by Simple Agent Manager)',
    };

    try {
      const res = await providerFetch('gcp', url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      }, this.timeoutMs);
      const op = (await res.json()) as GcpOperation;
      // Firewall operations are global, poll via global operations endpoint
      await this.pollGlobalOperation(op.name);
    } catch (err) {
      // 409 = already exists — that's fine
      if (err instanceof ProviderError && err.statusCode === 409) return;
      throw err;
    }
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
      const op = (await res.json()) as GcpOperation;

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

    // Ensure firewall rule exists before creating VM
    await this.ensureFirewallRule();

    const body = {
      name: config.name,
      machineType: `zones/${zone}/machineTypes/${machineType}`,
      labels: {
        'sam-managed': 'true',
        ...(config.labels || {}),
      },
      tags: {
        items: [SAM_NETWORK_TAG],
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

    const op = (await res.json()) as GcpOperation;
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
      const op = (await res.json()) as GcpOperation;
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
    const zonePromises = this.locations.map(async (zone) => {
      try {
        const url = `${this.projectUrl()}/zones/${zone}/instances?filter=${encodeURIComponent(filterStr)}`;
        const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
        const data = (await res.json()) as { items?: GcpInstance[] };
        return (data.items || []).map((i) => this.toVMInstance(i));
      } catch {
        // Zone may not be available — skip
        return [];
      }
    });

    const zoneResults = await Promise.allSettled(zonePromises);
    for (const result of zoneResults) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
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
    const op = (await res.json()) as GcpOperation;
    await this.pollOperation(zone, op.name);
  }

  async powerOn(id: string): Promise<void> {
    const instance = await this.findInstanceByIdOrName(id);
    if (!instance) throw new ProviderError('gcp', 404, `VM ${id} not found`);

    const zone = this.extractZone(instance.machineType);
    const headers = await this.authHeaders();
    const url = `${this.projectUrl()}/zones/${zone}/instances/${instance.name}/start`;
    const res = await providerFetch('gcp', url, { method: 'POST', headers }, this.timeoutMs);
    const op = (await res.json()) as GcpOperation;
    await this.pollOperation(zone, op.name);
  }

  async validateToken(): Promise<boolean> {
    const headers = await this.authHeaders();
    // Try a lightweight API call to verify credentials
    const url = `${this.projectUrl()}/zones/${this.defaultLocation}/machineTypes/e2-standard-2`;
    await providerFetch('gcp', url, { headers }, this.timeoutMs);
    return true;
  }

  /**
   * Find a GCP instance by numeric ID or name across all configured zones.
   */
  private async findInstanceByIdOrName(idOrName: string): Promise<GcpInstance | null> {
    const headers = await this.authHeaders();

    // First try as a name in each zone
    for (const zone of this.locations) {
      try {
        const url = `${this.projectUrl()}/zones/${zone}/instances/${idOrName}`;
        const res = await providerFetch('gcp', url, { headers }, this.timeoutMs);
        return (await res.json()) as GcpInstance;
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
      const data = (await res.json()) as { items?: Record<string, { instances?: GcpInstance[] }> };
      if (data.items) {
        for (const scopeData of Object.values(data.items)) {
          for (const instance of scopeData.instances || []) {
            if (instance.id === idOrName || instance.name === idOrName) {
              return instance;
            }
          }
        }
      }
    } catch {
      // Aggregated list may fail — fall through to null
    }

    return null;
  }

  private toVMInstance(instance: GcpInstance): VMInstance {
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

  /** Extract zone from a machineType URL like zones/us-central1-a/machineTypes/e2-standard-2 */
  private extractZone(machineType: string): string {
    const match = machineType.match(/zones\/([^/]+)/);
    return match?.[1] || this.defaultLocation;
  }
}
