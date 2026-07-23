import {
  digitalOceanTagsToLabels,
  DIGITALOCEAN_VOLUME_NAME_TAG_KEY,
  labelsToDigitalOceanTags,
} from './digitalocean-tags';
import { providerFetch } from './provider-fetch';
import type {
  VolumeAttachmentConfig,
  VolumeCapabilities,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
  VolumeStatus,
} from './types';
import {
  ProviderError,
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from './types';
import {
  type DigitalOceanActionPayload,
  type DigitalOceanVolumePayload,
  validateDigitalOceanActionResponse,
  validateDigitalOceanVolumeResponse,
  validateDigitalOceanVolumesResponse,
} from './validation-digitalocean';
import { parseProviderJson } from './validation';

const DIGITALOCEAN_API_URL = 'https://api.digitalocean.com/v2';
const DIGITALOCEAN_LIST_PER_PAGE = 200;
const DIGITALOCEAN_MAX_LIST_PAGES = 50;

export const DIGITALOCEAN_VOLUME_MIN_SIZE_GB = 1;
export const DIGITALOCEAN_VOLUME_MAX_SIZE_GB = 16_384;
export const DEFAULT_DIGITALOCEAN_ACTION_POLL_TIMEOUT_MS = 60_000;

/** DigitalOcean volume names: lowercase letters/numbers/hyphens, must start with a letter, <=64 chars. */
const DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH = 64;

export const DIGITALOCEAN_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: DIGITALOCEAN_VOLUME_MIN_SIZE_GB,
  maxSizeGb: DIGITALOCEAN_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'DigitalOcean Block Storage is available in all current DO regions; create the volume in the same region as its droplet.',
    'DO volume names are lowercased/sanitized/truncated to 64 chars; SAM round-trips the exact volume name via a sam-name tag. The provider creates raw block devices; SAM node-side code formats ext4 and mounts with nofail.',
    'linuxDevice is the deterministic DO by-id path /dev/disk/by-id/scsi-0DO_Volume_<name>.',
  ],
};

export type DigitalOceanErrorMapper = (err: unknown) => unknown;

export interface DigitalOceanVolumeClientOptions {
  requestTimeoutMs: number;
  actionPollTimeoutMs: number;
  actionPollIntervalMs: number;
}

/**
 * Sanitize a SAM volume name into a valid DigitalOcean volume name:
 * lowercase, `[a-z0-9-]` only, must start with a letter, <=64 chars, no trailing hyphen.
 */
export function sanitizeDigitalOceanVolumeName(name: string): string {
  let sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH)
    // Strip trailing hyphen AFTER truncating so a slice mid-hyphen can't leave a trailing '-'.
    .replace(/-+$/g, '');
  // DO requires the name to start with a letter.
  if (!/^[a-z]/.test(sanitized)) {
    sanitized = `v${sanitized}`.slice(0, DIGITALOCEAN_VOLUME_NAME_MAX_LENGTH).replace(/-+$/g, '');
  }
  return sanitized || 'sam-volume';
}

export class DigitalOceanVolumeClient {
  private readonly requestTimeoutMs: number;
  private readonly actionPollTimeoutMs: number;
  private readonly actionPollIntervalMs: number;

  constructor(
    private readonly apiToken: string,
    private readonly mapProviderError: DigitalOceanErrorMapper,
    options: DigitalOceanVolumeClientOptions,
  ) {
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.actionPollTimeoutMs = options.actionPollTimeoutMs;
    this.actionPollIntervalMs = options.actionPollIntervalMs;
  }

  async createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);

    // DO volume names are lossy (lowercased/sanitized/truncated). Round-trip the EXACT
    // SAM name via a sam-name tag so getVolume/listVolumes stays faithful.
    const tags = labelsToDigitalOceanTags({
      [DIGITALOCEAN_VOLUME_NAME_TAG_KEY]: config.name,
      ...(config.labels ?? {}),
    });

    let response: Response;
    try {
      response = await this.doFetch('/volumes', {
        method: 'POST',
        body: JSON.stringify({
          name: sanitizeDigitalOceanVolumeName(config.name),
          region: config.location,
          size_gigabytes: config.sizeGb,
          tags,
        }),
      });
    } catch (err) {
      throw this.mapProviderError(err);
    }

    const data = validateDigitalOceanVolumeResponse(
      await parseProviderJson(response, 'digitalocean', 'createVolume'),
      'createVolume',
    );
    return this.mapVolume(data.volume);
  }

  async attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    const dropletId = toDropletId(config.serverId);
    await this.runVolumeAction(config.volumeId, 'attachVolume', {
      type: 'attach',
      droplet_id: dropletId,
      region: config.location,
    });

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('digitalocean', 404, `DigitalOcean volume ${config.volumeId} not found after attach`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    const current = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!current) return null; // Already gone — idempotent.

    // Detach from whatever droplet the volume is actually attached to (authoritative),
    // falling back to the caller-supplied serverId. If nothing is attached, it's a no-op.
    const attached = current.attachedServerId ?? config.serverId;
    if (!attached) return current;

    await this.runVolumeAction(config.volumeId, 'detachVolume', {
      type: 'detach',
      droplet_id: toDropletId(attached),
      region: config.location,
    });

    return this.getVolume({ volumeId: config.volumeId, location: config.location });
  }

  async resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);
    const currentSizeGb = config.currentSizeGb ?? (await this.getCurrentVolumeSize(config));
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `Cannot shrink DigitalOcean volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' },
      );
    }

    await this.runVolumeAction(config.volumeId, 'resizeVolume', {
      type: 'resize',
      size_gigabytes: config.sizeGb,
      region: config.location,
    });

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('digitalocean', 404, `DigitalOcean volume ${config.volumeId} not found after resize`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    try {
      await this.doFetch(`/volumes/${encodeURIComponent(config.volumeId)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent
      }
      throw err;
    }
  }

  async getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    try {
      const response = await this.doFetch(`/volumes/${encodeURIComponent(config.volumeId)}`);
      const data = validateDigitalOceanVolumeResponse(
        await parseProviderJson(response, 'digitalocean', 'getVolume'),
        'getVolume',
      );
      return this.mapVolume(data.volume);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    const volumes = await this.fetchAllVolumes(config.location);
    let mapped = volumes.map((volume) => this.mapVolume(volume));

    if (config.labels && Object.keys(config.labels).length > 0) {
      const entries = Object.entries(config.labels);
      mapped = mapped.filter((volume) => entries.every(([key, value]) => volume.labels[key] === value));
    }
    return mapped;
  }

  private async fetchAllVolumes(location: string): Promise<DigitalOceanVolumePayload[]> {
    const all: DigitalOceanVolumePayload[] = [];
    for (let page = 1; page <= DIGITALOCEAN_MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams({
        per_page: String(DIGITALOCEAN_LIST_PER_PAGE),
        page: String(page),
        region: location,
      });
      const response = await this.doFetch(`/volumes?${params.toString()}`);
      const data = validateDigitalOceanVolumesResponse(
        await parseProviderJson(response, 'digitalocean', 'listVolumes'),
        'listVolumes',
      );
      all.push(...data.volumes);
      if (!data.hasNextPage) return all;
    }
    return all;
  }

  /** Issue a volume action and poll it to completion within the configured budget. */
  private async runVolumeAction(
    volumeId: string,
    context: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const response = await this.doFetch(`/volumes/${encodeURIComponent(volumeId)}/actions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = validateDigitalOceanActionResponse(
      await parseProviderJson(response, 'digitalocean', context),
      context,
    );
    await this.pollAction(data.action, context);
  }

  /** Poll a DigitalOcean async action to `completed`, hard-bounded by actionPollTimeoutMs. */
  private async pollAction(action: DigitalOceanActionPayload, context: string): Promise<void> {
    if (action.status === 'completed') return;
    if (action.status === 'errored') {
      throw new ProviderError('digitalocean', undefined, `DigitalOcean ${context} action ${action.id} errored`, {
        category: 'transient_capacity',
      });
    }

    const deadline = Date.now() + this.actionPollTimeoutMs;
    while (Date.now() < deadline) {
      await delay(Math.min(this.actionPollIntervalMs, deadline - Date.now()));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const current = await this.getAction(action.id, Math.min(this.requestTimeoutMs, remaining));
      if (current.status === 'completed') return;
      if (current.status === 'errored') {
        throw new ProviderError('digitalocean', undefined, `DigitalOcean ${context} action ${action.id} errored`, {
          category: 'transient_capacity',
        });
      }
    }
    throw new ProviderError(
      'digitalocean',
      undefined,
      `DigitalOcean ${context} action ${action.id} did not complete within ${this.actionPollTimeoutMs}ms`,
      { category: 'transient_capacity' },
    );
  }

  private async getAction(actionId: number, timeoutMs: number): Promise<DigitalOceanActionPayload> {
    const response = await this.doFetch(`/actions/${actionId}`, undefined, timeoutMs);
    const data = validateDigitalOceanActionResponse(
      await parseProviderJson(response, 'digitalocean', 'pollAction'),
      'pollAction',
    );
    return data.action;
  }

  private mapVolume(volume: DigitalOceanVolumePayload): VolumeInstance {
    const decoded = digitalOceanTagsToLabels(volume.tags);
    const { [DIGITALOCEAN_VOLUME_NAME_TAG_KEY]: encodedName, ...labels } = decoded;
    const attachedServerId = volume.droplet_ids.length > 0 ? String(volume.droplet_ids[0]) : undefined;

    return {
      id: volume.id,
      name: encodedName ?? volume.name,
      sizeGb: volume.size_gigabytes,
      location: volume.region_slug,
      status: this.mapStatus(attachedServerId),
      ...(attachedServerId ? { attachedServerId } : {}),
      // DO exposes attached volumes deterministically at this by-id path (from the DO name).
      ...(volume.name ? { linuxDevice: `/dev/disk/by-id/scsi-0DO_Volume_${volume.name}` } : {}),
      createdAt: volume.created_at,
      labels,
    };
  }

  private mapStatus(attachedServerId?: string): VolumeStatus {
    return attachedServerId ? 'attached' : 'available';
  }

  private validateRequestedVolumeSize(sizeGb: number): void {
    if (!Number.isInteger(sizeGb) || sizeGb < DIGITALOCEAN_VOLUME_MIN_SIZE_GB) {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `DigitalOcean volume size must be an integer >= ${DIGITALOCEAN_VOLUME_MIN_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
    if (sizeGb > DIGITALOCEAN_VOLUME_MAX_SIZE_GB) {
      throw new ProviderError(
        'digitalocean',
        undefined,
        `DigitalOcean volume size must be <= ${DIGITALOCEAN_VOLUME_MAX_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
  }

  private async getCurrentVolumeSize(config: VolumeResizeConfig): Promise<number> {
    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('digitalocean', 404, `DigitalOcean volume ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }

  private async doFetch(path: string, init?: RequestInit, timeoutMs: number = this.requestTimeoutMs): Promise<Response> {
    try {
      return await providerFetch(
        'digitalocean',
        `${DIGITALOCEAN_API_URL}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
          },
        },
        timeoutMs,
      );
    } catch (err) {
      throw this.mapProviderError(err);
    }
  }
}

/** Convert a SAM server id (stringified DO droplet integer id) into the integer DO API expects. */
function toDropletId(serverId: string): number {
  const dropletId = Number(serverId);
  if (!Number.isInteger(dropletId) || dropletId <= 0) {
    throw new ProviderError('digitalocean', undefined, `Invalid DigitalOcean droplet id: "${serverId}"`, {
      category: 'invalid_config',
    });
  }
  return dropletId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
