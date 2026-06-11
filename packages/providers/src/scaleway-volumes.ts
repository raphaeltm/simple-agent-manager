import { providerFetch } from './provider-fetch';
import {
  labelsToScalewayTags,
  scalewayTagsToLabels,
} from './scaleway-tags';
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
  parseProviderJson,
  type ScalewayBlockVolumePayload,
  validateScalewayBlockVolumeResponse,
  validateScalewayBlockVolumesResponse,
} from './validation';

const SCALEWAY_INSTANCE_API_URL = 'https://api.scaleway.com/instance/v1/zones';
const SCALEWAY_BLOCK_API_URL = 'https://api.scaleway.com/block/v1/zones';
const SCALEWAY_BYTES_PER_GB = 1_000_000_000;
export const SCALEWAY_VOLUME_MIN_SIZE_GB = 1;
export const SCALEWAY_VOLUME_MAX_SIZE_GB = 10_000;
export const SCALEWAY_MAX_VOLUMES_PER_SERVER = 15;
export const SCALEWAY_DEFAULT_VOLUME_IOPS = 5_000;
const SCALEWAY_BLOCK_VOLUME_TYPE = 'sbs_volume';

export const SCALEWAY_VOLUME_CAPABILITIES: VolumeCapabilities = {
  supported: true,
  minSizeGb: SCALEWAY_VOLUME_MIN_SIZE_GB,
  maxSizeGb: SCALEWAY_VOLUME_MAX_SIZE_GB,
  growOnlyResize: true,
  requiresSameLocation: true,
  maxAttachedVolumesPerServer: SCALEWAY_MAX_VOLUMES_PER_SERVER,
  defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
  lifecycle: {
    filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
    mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
    fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
  },
  notes: [
    'Scaleway Block Storage attach/detach uses the Instance API server attach-volume and detach-volume endpoints.',
    'The provider API creates raw block volumes; SAM node-side code must format ext4 and mount with nofail.',
  ],
};

export type ScalewayErrorMapper = (err: unknown) => unknown;

export class ScalewayVolumeClient {
  constructor(
    private readonly secretKey: string,
    private readonly projectId: string,
    private readonly mapProviderError: ScalewayErrorMapper,
  ) {}

  async createVolume(config: VolumeConfig): Promise<VolumeInstance> {
    this.validateRequestedVolumeSize(config.sizeGb);

    let response: Response;
    try {
      response = await providerFetch(
        'scaleway',
        `${SCALEWAY_BLOCK_API_URL}/${config.location}/volumes`,
        {
          method: 'POST',
          headers: {
            'X-Auth-Token': this.secretKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: config.name,
            project_id: this.projectId,
            perf_iops: SCALEWAY_DEFAULT_VOLUME_IOPS,
            from_empty: {
              size: this.gbToBytes(config.sizeGb),
            },
            tags: labelsToScalewayTags(config.labels || {}),
          }),
        },
      );
    } catch (err) {
      throw this.mapProviderError(err);
    }

    const data = validateScalewayBlockVolumeResponse(
      await parseProviderJson(response, 'scaleway', 'createVolume'),
      'createVolume',
    );
    return this.mapVolumeToInstance(data.volume);
  }

  async attachVolume(config: VolumeAttachmentConfig): Promise<VolumeInstance> {
    await providerFetch(
      'scaleway',
      `${SCALEWAY_INSTANCE_API_URL}/${config.location}/servers/${config.serverId}/attach-volume`,
      {
        method: 'POST',
        headers: {
          'X-Auth-Token': this.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          volume_id: config.volumeId,
          volume_type: SCALEWAY_BLOCK_VOLUME_TYPE,
          boot: false,
        }),
      },
    );

    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('scaleway', 404, `Scaleway volume ${config.volumeId} not found after attach`, {
        category: 'invalid_config',
      });
    }
    return volume;
  }

  async detachVolume(config: VolumeDetachConfig): Promise<VolumeInstance | null> {
    if (!config.serverId) {
      throw new ProviderError('scaleway', undefined, 'Scaleway detachVolume requires serverId', {
        category: 'invalid_config',
      });
    }

    try {
      await providerFetch(
        'scaleway',
        `${SCALEWAY_INSTANCE_API_URL}/${config.location}/servers/${config.serverId}/detach-volume`,
        {
          method: 'POST',
          headers: {
            'X-Auth-Token': this.secretKey,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ volume_id: config.volumeId }),
        },
      );
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
    const currentSizeGb = config.currentSizeGb ?? await this.getCurrentVolumeSize(config);
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        'scaleway',
        undefined,
        `Cannot shrink Scaleway volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' },
      );
    }

    const response = await providerFetch(
      'scaleway',
      `${SCALEWAY_BLOCK_API_URL}/${config.location}/volumes/${config.volumeId}`,
      {
        method: 'PATCH',
        headers: {
          'X-Auth-Token': this.secretKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ size: this.gbToBytes(config.sizeGb) }),
      },
    );

    const data = validateScalewayBlockVolumeResponse(
      await parseProviderJson(response, 'scaleway', 'resizeVolume'),
      'resizeVolume',
    );
    return this.mapVolumeToInstance(data.volume);
  }

  async deleteVolume(config: VolumeLookupConfig): Promise<void> {
    try {
      await providerFetch(
        'scaleway',
        `${SCALEWAY_BLOCK_API_URL}/${config.location}/volumes/${config.volumeId}`,
        {
          method: 'DELETE',
          headers: { 'X-Auth-Token': this.secretKey },
        },
      );
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async getVolume(config: VolumeLookupConfig): Promise<VolumeInstance | null> {
    try {
      const response = await providerFetch(
        'scaleway',
        `${SCALEWAY_BLOCK_API_URL}/${config.location}/volumes/${config.volumeId}`,
        {
          headers: { 'X-Auth-Token': this.secretKey },
        },
      );

      const data = validateScalewayBlockVolumeResponse(
        await parseProviderJson(response, 'scaleway', 'getVolume'),
        'getVolume',
      );
      return this.mapVolumeToInstance(data.volume);
    } catch (err) {
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(config: VolumeListConfig): Promise<VolumeInstance[]> {
    const params = new URLSearchParams({
      project_id: this.projectId,
      include_deleted: 'false',
    });
    if (config.labels) {
      for (const tag of labelsToScalewayTags(config.labels)) {
        params.append('tags', tag);
      }
    }

    const response = await providerFetch(
      'scaleway',
      `${SCALEWAY_BLOCK_API_URL}/${config.location}/volumes?${params.toString()}`,
      {
        headers: { 'X-Auth-Token': this.secretKey },
      },
    );

    const data = validateScalewayBlockVolumesResponse(
      await parseProviderJson(response, 'scaleway', 'listVolumes'),
      'listVolumes',
    );
    return data.volumes.map((volume) => this.mapVolumeToInstance(volume));
  }

  private mapVolumeToInstance(volume: ScalewayBlockVolumePayload): VolumeInstance {
    const attachedReference = volume.references.find((reference) => reference.status === 'attached')
      ?? volume.references[0];

    return {
      id: volume.id,
      name: volume.name,
      sizeGb: this.bytesToGb(volume.size),
      location: volume.zone,
      status: this.mapVolumeStatus(volume.status, attachedReference?.status),
      ...(attachedReference ? { attachedServerId: attachedReference.id } : {}),
      volumeType: volume.type,
      createdAt: volume.created_at,
      labels: scalewayTagsToLabels(volume.tags || []),
    };
  }

  private mapVolumeStatus(status: string, referenceStatus?: string): VolumeStatus {
    switch (referenceStatus) {
      case 'attaching':
        return 'attaching';
      case 'attached':
        return 'attached';
      case 'detaching':
        return 'detaching';
    }

    switch (status) {
      case 'creating':
        return 'creating';
      case 'available':
        return 'available';
      case 'in_use':
        return 'attached';
      case 'snapshotting':
        return 'unknown';
      default:
        return 'unknown';
    }
  }

  private validateRequestedVolumeSize(sizeGb: number): void {
    if (!Number.isInteger(sizeGb) || sizeGb < SCALEWAY_VOLUME_MIN_SIZE_GB) {
      throw new ProviderError(
        'scaleway',
        undefined,
        `Scaleway volume size must be an integer >= ${SCALEWAY_VOLUME_MIN_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
    if (sizeGb > SCALEWAY_VOLUME_MAX_SIZE_GB) {
      throw new ProviderError(
        'scaleway',
        undefined,
        `Scaleway volume size must be <= ${SCALEWAY_VOLUME_MAX_SIZE_GB}GB`,
        { category: 'invalid_config' },
      );
    }
  }

  private async getCurrentVolumeSize(config: VolumeResizeConfig): Promise<number> {
    const volume = await this.getVolume({ volumeId: config.volumeId, location: config.location });
    if (!volume) {
      throw new ProviderError('scaleway', 404, `Scaleway volume ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }

  private gbToBytes(sizeGb: number): number {
    return sizeGb * SCALEWAY_BYTES_PER_GB;
  }

  private bytesToGb(sizeBytes: number): number {
    return sizeBytes / SCALEWAY_BYTES_PER_GB;
  }

}
