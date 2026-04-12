import type { VMSize } from '@simple-agent-manager/shared';
import {
  DEFAULT_SCALEWAY_IMAGE_NAME,
  DEFAULT_SCALEWAY_ZONE,
} from '@simple-agent-manager/shared';

import { providerFetch } from './provider-fetch';
import type { LocationMeta, Provider, SizeConfig, VMConfig, VMInstance, VMStatus } from './types';
import { ProviderError } from './types';

const SCALEWAY_INSTANCE_API_URL = 'https://api.scaleway.com/instance/v1/zones';

export const SCALEWAY_LOCATIONS = [
  'fr-par-1', 'fr-par-2', 'fr-par-3',
  'nl-ams-1', 'nl-ams-2', 'nl-ams-3',
  'pl-waw-1', 'pl-waw-2',
] as const;

const SCALEWAY_LOCATION_META: Record<string, LocationMeta> = {
  'fr-par-1': { name: 'Paris 1', country: 'FR' },
  'fr-par-2': { name: 'Paris 2', country: 'FR' },
  'fr-par-3': { name: 'Paris 3', country: 'FR' },
  'nl-ams-1': { name: 'Amsterdam 1', country: 'NL' },
  'nl-ams-2': { name: 'Amsterdam 2', country: 'NL' },
  'nl-ams-3': { name: 'Amsterdam 3', country: 'NL' },
  'pl-waw-1': { name: 'Warsaw 1', country: 'PL' },
  'pl-waw-2': { name: 'Warsaw 2', country: 'PL' },
};

const SIZE_CONFIGS: Record<VMSize, SizeConfig> = {
  small: {
    type: 'DEV1-M',
    price: '~€0.024/hr',
    vcpu: 3,
    ramGb: 4,
    storageGb: 40,
  },
  medium: {
    type: 'DEV1-XL',
    price: '~€0.048/hr',
    vcpu: 4,
    ramGb: 12,
    storageGb: 120,
  },
  large: {
    type: 'GP1-S',
    price: '~€0.084/hr',
    vcpu: 8,
    ramGb: 32,
    storageGb: 600,
  },
};

/** Response shape from Scaleway POST/GET /servers */
interface ScalewayServerResponse {
  server: {
    id: string;
    name: string;
    state: string;
    public_ip: { address: string } | null;
    public_ips: Array<{ address: string }>;
    commercial_type: string;
    creation_date: string;
    tags: string[];
  };
}

interface ScalewayServersResponse {
  servers: ScalewayServerResponse['server'][];
}

interface ScalewayImageResponse {
  images: Array<{ id: string; name: string }>;
}

export class ScalewayProvider implements Provider {
  readonly name = 'scaleway';
  readonly locations: readonly string[] = SCALEWAY_LOCATIONS;
  readonly locationMetadata: Readonly<Record<string, LocationMeta>> = SCALEWAY_LOCATION_META;
  readonly sizes: Readonly<Record<VMSize, SizeConfig>> = SIZE_CONFIGS;
  readonly defaultLocation: string;

  private readonly secretKey: string;
  private readonly projectId: string;
  private readonly zone: string;
  private readonly imageName: string;

  constructor(
    secretKey: string,
    projectId: string,
    zone?: string,
    imageName?: string,
  ) {
    this.secretKey = secretKey;
    this.projectId = projectId;
    this.zone = zone || DEFAULT_SCALEWAY_ZONE;
    this.defaultLocation = this.zone;
    this.imageName = imageName || DEFAULT_SCALEWAY_IMAGE_NAME;
  }

  /**
   * Three-step VM creation:
   * 1. POST /servers — creates server in stopped state
   * 2. PATCH /servers/:id/user_data/cloud-init — sets cloud-init (text/plain)
   * 3. POST /servers/:id/action — powers on the server
   *
   * Note: Scaleway allocates IPs only after boot, so the returned VMInstance
   * will have an empty `ip` field. The caller (provisionNode) handles this via
   * fail-fast guard + heartbeat IP backfill.
   */
  async createVM(config: VMConfig): Promise<VMInstance> {
    const sizeConfig = this.sizes[config.size];
    if (!sizeConfig) {
      throw new ProviderError(this.name, undefined, `Unknown VM size: ${config.size}`);
    }
    const location = config.location || this.zone;

    // Resolve image UUID by name for the target zone
    const imageId = await this.resolveImageId(location, config.image);

    // Convert labels to tags: ["key=value", ...]
    const tags = this.labelsToTags(config.labels || {});

    // Step 1: Create server (stopped)
    const createResponse = await providerFetch(
      this.name,
      `${SCALEWAY_INSTANCE_API_URL}/${location}/servers`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: config.name,
          commercial_type: sizeConfig.type,
          image: imageId,
          project: this.projectId,
          dynamic_ip_required: true,
          tags,
        }),
      },
    );

    const createData = (await createResponse.json()) as ScalewayServerResponse;
    const serverId = createData.server.id;

    // Step 2: Set cloud-init user data
    await providerFetch(
      this.name,
      `${SCALEWAY_INSTANCE_API_URL}/${location}/servers/${serverId}/user_data/cloud-init`,
      {
        method: 'PATCH',
        headers: {
          'X-Auth-Token': this.secretKey,
          'Content-Type': 'text/plain',
        },
        body: config.userData,
      },
    );

    // Step 3: Power on
    await this.performAction(location, serverId, 'poweron');

    // Return immediately — IP will be empty at this point.
    // Scaleway allocates IPs asynchronously after boot.
    // The heartbeat IP backfill in the nodes route will capture the IP
    // when the VM agent sends its first heartbeat.
    return this.mapServerToVMInstance(createData.server);
  }

  async deleteVM(id: string): Promise<void> {
    try {
      // Scaleway cannot delete running servers — try terminate action first
      // which handles poweroff + delete in one step
      await this.performAction(this.zone, id, 'terminate');
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent: already deleted
      }
      // If terminate fails (e.g., server already stopped), try direct DELETE
      if (err instanceof ProviderError && err.statusCode === 400) {
        try {
          await providerFetch(
            this.name,
            `${SCALEWAY_INSTANCE_API_URL}/${this.zone}/servers/${id}`,
            {
              method: 'DELETE',
              headers: { 'X-Auth-Token': this.secretKey },
            },
          );
        } catch (deleteErr) {
          if (deleteErr instanceof ProviderError && deleteErr.statusCode === 404) {
            return; // Idempotent
          }
          throw deleteErr;
        }
        return;
      }
      throw err;
    }
  }

  async getVM(id: string): Promise<VMInstance | null> {
    try {
      const response = await providerFetch(
        this.name,
        `${SCALEWAY_INSTANCE_API_URL}/${this.zone}/servers/${id}`,
        {
          headers: { 'X-Auth-Token': this.secretKey },
        },
      );

      const data = (await response.json()) as ScalewayServerResponse;
      return this.mapServerToVMInstance(data.server);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVMs(labels?: Record<string, string>): Promise<VMInstance[]> {
    const params = new URLSearchParams();
    if (labels) {
      // Scaleway filters by individual tags — use the first label as primary filter
      const tags = this.labelsToTags(labels);
      for (const tag of tags) {
        params.append('tags', tag);
      }
    }

    const queryString = params.toString();
    const url = queryString
      ? `${SCALEWAY_INSTANCE_API_URL}/${this.zone}/servers?${queryString}`
      : `${SCALEWAY_INSTANCE_API_URL}/${this.zone}/servers`;

    const response = await providerFetch(this.name, url, {
      headers: { 'X-Auth-Token': this.secretKey },
    });

    const data = (await response.json()) as ScalewayServersResponse;
    return data.servers.map((server) => this.mapServerToVMInstance(server));
  }

  async powerOff(id: string): Promise<void> {
    await this.performAction(this.zone, id, 'poweroff');
  }

  async powerOn(id: string): Promise<void> {
    await this.performAction(this.zone, id, 'poweron');
  }

  async validateToken(): Promise<boolean> {
    // Validate by listing servers scoped to the user's project.
    // The Account API v3 requires organization_id which we don't collect,
    // so we use the Instance API instead — this also validates that the
    // credentials work for the API we actually need.
    await providerFetch(
      this.name,
      `${SCALEWAY_INSTANCE_API_URL}/${this.zone}/servers?per_page=1&project=${this.projectId}`,
      {
        headers: { 'X-Auth-Token': this.secretKey },
      },
    );
    return true;
  }

  /**
   * Resolve an OS image UUID by name for a given zone.
   * If the image parameter looks like a UUID, use it directly.
   */
  private async resolveImageId(zone: string, image?: string): Promise<string> {
    // If caller provided a UUID-like string, use it directly
    if (image && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(image)) {
      return image;
    }

    const imageName = image || this.imageName;
    const response = await providerFetch(
      this.name,
      `${SCALEWAY_INSTANCE_API_URL}/${zone}/images?name=${encodeURIComponent(imageName)}&arch=x86_64`,
      {
        headers: { 'X-Auth-Token': this.secretKey },
      },
    );

    const data = (await response.json()) as ScalewayImageResponse;
    if (data.images.length === 0) {
      throw new ProviderError(
        this.name,
        undefined,
        `No image found matching name "${imageName}" in zone ${zone}`,
      );
    }

    return data.images[0]!.id;
  }

  private async performAction(zone: string, serverId: string, action: string): Promise<void> {
    await providerFetch(
      this.name,
      `${SCALEWAY_INSTANCE_API_URL}/${zone}/servers/${serverId}/action`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      },
    );
  }

  private mapServerToVMInstance(server: ScalewayServerResponse['server']): VMInstance {
    // Extract IP: prefer public_ip, then first public_ips entry
    const ip = server.public_ip?.address
      || (server.public_ips?.length > 0 ? server.public_ips[0]!.address : '');

    return {
      id: server.id,
      name: server.name,
      ip,
      status: this.mapStatus(server.state),
      serverType: server.commercial_type,
      createdAt: server.creation_date,
      labels: this.tagsToLabels(server.tags || []),
    };
  }

  private mapStatus(scalewayState: string): VMStatus {
    switch (scalewayState) {
      case 'running':
        return 'running';
      case 'stopped':
        return 'off';
      case 'stopping':
        return 'stopping';
      case 'starting':
        return 'starting';
      case 'locked':
      default:
        return 'initializing';
    }
  }

  /** Convert Record<string, string> labels to Scaleway tag array: ["key=value", ...] */
  private labelsToTags(labels: Record<string, string>): string[] {
    return Object.entries(labels).map(([key, value]) => `${key}=${value}`);
  }

  /** Convert Scaleway tag array back to Record<string, string> labels */
  private tagsToLabels(tags: string[]): Record<string, string> {
    const labels: Record<string, string> = {};
    for (const tag of tags) {
      const eqIndex = tag.indexOf('=');
      if (eqIndex > 0) {
        labels[tag.slice(0, eqIndex)] = tag.slice(eqIndex + 1);
      }
    }
    return labels;
  }
}
