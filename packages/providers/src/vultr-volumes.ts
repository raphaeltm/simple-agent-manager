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
import { parseProviderJson } from './validation';
import {
  validateVultrBlockResponse,
  validateVultrBlocksResponse,
  type VultrBlockPayload,
} from './validation-vultr';
import { decodeVultrBlockLabel, encodeVultrBlockLabel } from './vultr-labels';

const VULTR_API_URL = 'https://api.vultr.com/v2';
const VULTR_LIST_PER_PAGE = 100;
const VULTR_MAX_LIST_PAGES = 50;
/** Reserved label key used to round-trip the SAM volume name through Vultr's single label string. */
const VULTR_VOLUME_NAME_LABEL_KEY = 'sam-name';
/** Vultr high-performance (NVMe) block storage. `storage_opt` (HDD) is the cheaper alternative. */
const VULTR_BLOCK_TYPE = 'high_perf';

export const VULTR_VOLUME_MIN_SIZE_GB = 10;
export const VULTR_VOLUME_MAX_SIZE_GB = 10_240;

export const VULTR_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: VULTR_VOLUME_MIN_SIZE_GB,
  maxSizeGb: VULTR_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'Vultr Block Storage (high_perf NVMe) is available only in a subset of Vultr regions — create in a block-storage-capable region matching the instance.',
    'Vultr blocks expose a single free-form label string, not key/value tags; SAM encodes its labels (and the volume name) into that label. The provider creates raw block devices; SAM node-side code formats ext4 and mounts with nofail.',
    'linuxDevice is a best-effort virtio-by-id path derived from Vultr mount_id and may require node-side resolution.',
  ],
};

export type VultrErrorMapper = (err: unknown) => unknown;

export class VultrVolumeClient {
  constructor(
    private readonly apiToken: string,
    private readonly mapProviderError: VultrErrorMapper,
    private readonly requestTimeoutMs: number,
  ) {}

  async createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);

    const label = encodeVultrBlockLabel({
      [VULTR_VOLUME_NAME_LABEL_KEY]: config.name,
      ...(config.labels ?? {}),
    });

    let response: Response;
    try {
      response = await this.vultrFetch('/blocks', {
        method: 'POST',
        body: JSON.stringify({
          region: config.location,
          size_gb: config.sizeGb,
          label,
          block_type: VULTR_BLOCK_TYPE,
        }),
      });
    } catch (err) {
      throw this.mapProviderError(err);
    }

    const data = validateVultrBlockResponse(
      await parseProviderJson(response, 'vultr', 'createVolume'),
      'createVolume',
    );
    return this.mapVolume(data.block);
  }

  async attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    await this.vultrFetch(`/blocks/${encodeURIComponent(config.volumeId)}/attach`, {
      method: 'POST',
      body: JSON.stringify({ instance_id: config.serverId, live: true }),
    });

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('vultr', 404, `Vultr block ${config.volumeId} not found after attach`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    try {
      await this.vultrFetch(`/blocks/${encodeURIComponent(config.volumeId)}/detach`, {
        method: 'POST',
        body: JSON.stringify({ live: true }),
      });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }

    return this.getVolume({ volumeId: config.volumeId, location: config.location });
  }

  async resizeVolume(config: VolumeResizeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);
    const currentSizeGb = config.currentSizeGb ?? (await this.getCurrentVolumeSize(config));
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        'vultr',
        undefined,
        `Cannot shrink Vultr block ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' },
      );
    }

    await this.vultrFetch(`/blocks/${encodeURIComponent(config.volumeId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ size_gb: config.sizeGb }),
    });

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('vultr', 404, `Vultr block ${config.volumeId} not found after resize`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    try {
      await this.vultrFetch(`/blocks/${encodeURIComponent(config.volumeId)}`, { method: 'DELETE' });
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return; // Idempotent
      }
      throw err;
    }
  }

  async getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    try {
      const response = await this.vultrFetch(`/blocks/${encodeURIComponent(config.volumeId)}`);
      const data = validateVultrBlockResponse(
        await parseProviderJson(response, 'vultr', 'getVolume'),
        'getVolume',
      );
      return this.mapVolume(data.block);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    const blocks = await this.fetchAllBlocks();
    let volumes = blocks
      .map((block) => this.mapVolume(block))
      .filter((volume) => volume.location === config.location);

    if (config.labels && Object.keys(config.labels).length > 0) {
      const entries = Object.entries(config.labels);
      volumes = volumes.filter((volume) => entries.every(([key, value]) => volume.labels[key] === value));
    }
    return volumes;
  }

  private async fetchAllBlocks(): Promise<VultrBlockPayload[]> {
    const all: VultrBlockPayload[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < VULTR_MAX_LIST_PAGES; page += 1) {
      const params = new URLSearchParams({ per_page: String(VULTR_LIST_PER_PAGE) });
      if (cursor) params.set('cursor', cursor);
      const response = await this.vultrFetch(`/blocks?${params.toString()}`);
      const data = validateVultrBlocksResponse(
        await parseProviderJson(response, 'vultr', 'listVolumes'),
        'listVolumes',
      );
      all.push(...data.blocks);
      if (!data.nextCursor) break;
      cursor = data.nextCursor;
    }
    return all;
  }

  private mapVolume(block: VultrBlockPayload): VolumeInstance {
    const decoded = decodeVultrBlockLabel(block.label);
    const { [VULTR_VOLUME_NAME_LABEL_KEY]: encodedName, ...labels } = decoded;
    const attachedServerId = block.attached_to_instance || undefined;

    return {
      id: block.id,
      name: encodedName ?? block.label,
      sizeGb: block.size_gb,
      location: block.region,
      status: this.mapStatus(block.status, attachedServerId),
      ...(attachedServerId ? { attachedServerId } : {}),
      ...(block.mount_id ? { linuxDevice: `/dev/disk/by-id/virtio-${block.mount_id}` } : {}),
      volumeType: block.block_type,
      createdAt: block.date_created,
      labels,
    };
  }

  private mapStatus(status: string, attachedServerId?: string): VolumeStatus {
    if (attachedServerId) return 'attached';
    switch (status) {
      case 'pending':
        return 'creating';
      case 'active':
        return 'available';
      default:
        return 'unknown';
    }
  }

  private validateRequestedVolumeSize(sizeGb: number): void {
    if (!Number.isInteger(sizeGb) || sizeGb < VULTR_VOLUME_MIN_SIZE_GB) {
      throw new ProviderError(
        'vultr',
        undefined,
        `Vultr block size must be an integer >= ${VULTR_VOLUME_MIN_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
    if (sizeGb > VULTR_VOLUME_MAX_SIZE_GB) {
      throw new ProviderError(
        'vultr',
        undefined,
        `Vultr block size must be <= ${VULTR_VOLUME_MAX_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
  }

  private async getCurrentVolumeSize(config: VolumeResizeConfig): Promise<number> {
    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('vultr', 404, `Vultr block ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }

  private async vultrFetch(path: string, init?: RequestInit): Promise<Response> {
    try {
      return await providerFetch(
        'vultr',
        `${VULTR_API_URL}${path}`,
        {
          ...init,
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
          },
        },
        this.requestTimeoutMs,
      );
    } catch (err) {
      throw this.mapProviderError(err);
    }
  }
}
