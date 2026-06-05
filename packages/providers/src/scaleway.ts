import type { VMSize } from '@simple-agent-manager/shared';
import {
  DEFAULT_SCALEWAY_IMAGE_NAME,
  DEFAULT_SCALEWAY_ZONE,
} from '@simple-agent-manager/shared';

import { providerFetch } from './provider-fetch';
import type { LocationMeta, Provider, ProviderErrorCategory, ProviderErrorContext, SizeConfig, VMConfig, VMInstance, VMStatus } from './types';
import { ProviderError } from './types';
import {
  parseProviderJson,
  type ScalewayServerPayload,
  validateScalewayImageResponse,
  validateScalewayServerResponse,
  validateScalewayServersResponse,
} from './validation';

const SCALEWAY_INSTANCE_API_URL = 'https://api.scaleway.com/instance/v1/zones';

/**
 * Classify a Scaleway API error into a normalized ProviderErrorCategory.
 *
 * Scaleway error responses use `{ message, type }` where `type` is the structured signal.
 * The `providerCode` in ProviderError corresponds to the `type` field.
 *
 * Scaleway error types (from API docs):
 * - transient → transient_capacity (503 with transient type)
 * - not_found → invalid_config
 * - invalid_request_error → invalid_config
 * - quota_exceeded → quota_exceeded
 * - permission_denied → auth_error
 * - denied → auth_error
 *
 * HTTP status heuristics:
 * - 503 without recognized type → transient_capacity
 * - 429 → rate_limited
 * - 401/403 → auth_error
 */
export function classifyScalewayError(
  statusCode: number | undefined,
  providerCode: string | undefined,
  message: string,
): ProviderErrorCategory {
  if (providerCode) {
    switch (providerCode) {
      case 'transient':
        return 'transient_capacity';
      case 'quota_exceeded':
        return 'quota_exceeded';
      case 'invalid_request_error':
      case 'not_found':
        return 'invalid_config';
      case 'permission_denied':
      case 'denied':
        return 'auth_error';
    }
  }

  if (statusCode === 401 || statusCode === 403) return 'auth_error';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode === 503) return 'transient_capacity';

  // Message-based fallback for capacity-related errors
  if (statusCode === 400 || statusCode === 409) {
    if (/insufficient capacity|no available|resource.*unavailable/i.test(message)) {
      return 'transient_capacity';
    }
  }

  return 'unknown';
}

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

    const createData = validateScalewayServerResponse(
      await parseProviderJson(createResponse, this.name, 'createVM.createServer'),
      'createVM.createServer',
    );
    const serverId = createData.server.id;

    try {
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
    } catch (err) {
      throw await this.withCreatedServerCleanupContext(err, location, serverId, 'cloud-init-upload');
    }

    try {
      // Step 3: Power on
      await this.performAction(location, serverId, 'poweron');
    } catch (err) {
      throw await this.withCreatedServerCleanupContext(err, location, serverId, 'poweron');
    }

    // Return immediately — IP will be empty at this point.
    // Scaleway allocates IPs asynchronously after boot.
    // The heartbeat IP backfill in the nodes route will capture the IP
    // when the VM agent sends its first heartbeat.
    return this.mapServerToVMInstance(createData.server);
  }

  async deleteVM(id: string): Promise<void> {
    const server = await this.findServerInAnyZone(id);
    if (!server) return;

    await this.cleanupKnownServer(server.zone, id);
  }

  private async cleanupKnownServer(zone: string, serverId: string): Promise<void> {
    try {
      // Scaleway cannot delete running servers — try terminate action first
      // which handles poweroff + delete in one step
      await this.performAction(zone, serverId, 'terminate');
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent: already deleted
      }
      // If terminate fails (e.g., server already stopped), try direct DELETE
      if (err instanceof ProviderError && err.statusCode === 400) {
        try {
          await providerFetch(
            this.name,
            `${SCALEWAY_INSTANCE_API_URL}/${zone}/servers/${serverId}`,
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

  private async withCreatedServerCleanupContext(
    original: unknown,
    zone: string,
    serverId: string,
    failedStep: 'cloud-init-upload' | 'poweron',
  ): Promise<Error> {
    try {
      await this.cleanupKnownServer(zone, serverId);
      return this.normalizeCreateFailure(original);
    } catch (cleanupErr) {
      const originalError = this.normalizeCreateFailure(original);
      return new ProviderError(
        this.name,
        originalError instanceof ProviderError ? originalError.statusCode : undefined,
        originalError.message,
        {
          cause: originalError,
          context: {
            failedStep,
            cleanup: this.cleanupContext(zone, serverId, cleanupErr),
          },
        },
      );
    }
  }

  private cleanupContext(zone: string, serverId: string, cleanupErr: unknown): ProviderErrorContext {
    return {
      operation: 'cleanup-created-server',
      provider: this.name,
      zone,
      serverId,
      error: this.errorContext(cleanupErr),
    };
  }

  private errorContext(err: unknown): ProviderErrorContext {
    if (err instanceof ProviderError) {
      return {
        name: err.name,
        provider: err.providerName,
        statusCode: err.statusCode,
        message: err.message,
      };
    }
    if (err instanceof Error) {
      return {
        name: err.name,
        message: err.message,
      };
    }
    return {
      message: String(err),
    };
  }

  private normalizeCreateFailure(err: unknown): Error {
    if (err instanceof Error) return err;
    return new ProviderError(this.name, undefined, `Scaleway createVM failed: ${String(err)}`);
  }

  async getVM(id: string): Promise<VMInstance | null> {
    const server = await this.findServerInAnyZone(id);
    return server ? this.mapServerToVMInstance(server.payload) : null;
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

    const vms: VMInstance[] = [];
    for (const zone of this.scalewayZones()) {
      const queryString = params.toString();
      const url = queryString
        ? `${SCALEWAY_INSTANCE_API_URL}/${zone}/servers?${queryString}`
        : `${SCALEWAY_INSTANCE_API_URL}/${zone}/servers`;

      try {
        const response = await providerFetch(this.name, url, {
          headers: { 'X-Auth-Token': this.secretKey },
        });

        const data = validateScalewayServersResponse(
          await parseProviderJson(response, this.name, `listVMs.${zone}`),
          `listVMs.${zone}`,
        );
        vms.push(...data.servers.map((server) => this.mapServerToVMInstance(server)));
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 404) continue;
        throw err;
      }
    }
    return vms;
  }

  async powerOff(id: string): Promise<void> {
    const server = await this.findServerInAnyZone(id);
    if (!server) {
      throw new ProviderError(this.name, 404, `Scaleway server ${id} not found`);
    }
    await this.performAction(server.zone, id, 'poweroff');
  }

  async powerOn(id: string): Promise<void> {
    const server = await this.findServerInAnyZone(id);
    if (!server) {
      throw new ProviderError(this.name, 404, `Scaleway server ${id} not found`);
    }
    await this.performAction(server.zone, id, 'poweron');
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

    const data = validateScalewayImageResponse(
      await parseProviderJson(response, this.name, 'resolveImageId'),
      'resolveImageId',
    );
    if (data.images.length === 0) {
      throw new ProviderError(
        this.name,
        undefined,
        `No image found matching name "${imageName}" in zone ${zone}`,
      );
    }

    const [firstImage] = data.images;
    if (!firstImage) {
      throw new ProviderError(
        this.name,
        undefined,
        `No image found matching name "${imageName}" in zone ${zone}`,
      );
    }
    return firstImage.id;
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

  private async findServerInAnyZone(id: string): Promise<{ zone: string; payload: ScalewayServerPayload } | null> {
    for (const zone of this.scalewayZones()) {
      try {
        const response = await providerFetch(
          this.name,
          `${SCALEWAY_INSTANCE_API_URL}/${zone}/servers/${id}`,
          {
            headers: { 'X-Auth-Token': this.secretKey },
          },
        );

        const data = validateScalewayServerResponse(
          await parseProviderJson(response, this.name, `findServerInAnyZone.${zone}`),
          `findServerInAnyZone.${zone}`,
        );
        return { zone, payload: data.server };
      } catch (err) {
        if (err instanceof ProviderError && err.statusCode === 404) continue;
        throw err;
      }
    }
    return null;
  }

  private scalewayZones(): readonly string[] {
    return [
      this.zone,
      ...SCALEWAY_LOCATIONS.filter((zone) => zone !== this.zone),
    ];
  }

  private mapServerToVMInstance(server: ScalewayServerPayload): VMInstance {
    // Extract IP: prefer public_ip, then first public_ips entry
    const [firstPublicIp] = server.public_ips;
    const ip = server.public_ip?.address || firstPublicIp?.address || '';

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
