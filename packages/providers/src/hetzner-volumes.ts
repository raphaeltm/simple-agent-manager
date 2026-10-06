/**
 * Hetzner block-volume operations for `HetznerProvider`.
 *
 * Split out of `hetzner.ts` (rule 18). Pure code motion: every method body is unchanged apart
 * from calling the shared `hetznerLabelSelectorParts`; the provider delegates to one instance.
 */
import {
  HETZNER_API_URL,
  isAlreadyDetachedVolumeError,
  mapHetznerProviderError,
  mapHetznerVolumeToInstance,
  validateHetznerVolumeSize,
} from './hetzner-metadata';
import { fetchPaginatedHetznerList, hetznerLabelSelectorParts } from './hetzner-pagination';
import {
  providerFetch,
  rethrowIfProviderRequestAborted,
  throwIfProviderRequestAborted,
} from './provider-fetch';
import type {
  ProviderRequestContext,
  VolumeAttachmentConfig,
  VolumeConfig,
  VolumeDetachConfig,
  VolumeInstance,
  VolumeListConfig,
  VolumeLookupConfig,
  VolumeResizeConfig,
} from './types';
import { ProviderError, SAM_VOLUME_FILESYSTEM_FORMAT } from './types';
import {
  type HetznerVolumePayload,
  parseProviderJson,
  validateHetznerVolumeResponse,
  validateHetznerVolumesResponse,
} from './validation';

export class HetznerVolumes {
  readonly name = 'hetzner';

  constructor(
    private readonly apiToken: string,
    private readonly maxListPages: number
  ) {}

  async createVolume(
    config: VolumeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    validateHetznerVolumeSize(config.sizeGb);

    let response: Response;
    try {
      response = await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: config.name,
            size: config.sizeGb,
            location: config.location,
            format: config.format ?? SAM_VOLUME_FILESYSTEM_FORMAT,
            labels: config.labels || {},
          }),
        },
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      throw mapHetznerProviderError(err);
    }

    throwIfProviderRequestAborted(context);
    const data = validateHetznerVolumeResponse(
      await parseProviderJson(response, this.name, 'createVolume'),
      'createVolume'
    );
    throwIfProviderRequestAborted(context);
    return mapHetznerVolumeToInstance(data.volume);
  }

  async attachVolume(
    config: VolumeAttachmentConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/attach`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          server: Number(config.serverId),
          automount: false,
        }),
      },
      undefined,
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        this.name,
        404,
        `Hetzner volume ${config.volumeId} not found after attach`,
        {
          category: 'invalid_config',
        }
      );
    }
    return volume;
  }

  async detachVolume(
    config: VolumeDetachConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    try {
      await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/detach`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({}),
        },
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError) {
        if (err.statusCode === 404) {
          return null;
        }
        if (isAlreadyDetachedVolumeError(err)) {
          return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
        }
      }
      throw err;
    }

    throwIfProviderRequestAborted(context);
    return this.getVolume({ volumeId: config.volumeId, location: config.location }, context);
  }

  async resizeVolume(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance> {
    throwIfProviderRequestAborted(context);
    validateHetznerVolumeSize(config.sizeGb);
    const currentSizeGb =
      config.currentSizeGb ?? (await this.getCurrentVolumeSize(config, context));
    if (config.sizeGb < currentSizeGb) {
      throw new ProviderError(
        this.name,
        undefined,
        `Cannot shrink Hetzner volume ${config.volumeId} from ${currentSizeGb}GB to ${config.sizeGb}GB`,
        { category: 'invalid_config' }
      );
    }

    await providerFetch(
      this.name,
      `${HETZNER_API_URL}/volumes/${config.volumeId}/actions/resize`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ size: config.sizeGb }),
      },
      undefined,
      undefined,
      context
    );

    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(
        this.name,
        404,
        `Hetzner volume ${config.volumeId} not found after resize`,
        {
          category: 'invalid_config',
        }
      );
    }
    return volume;
  }

  async deleteVolume(config: VolumeLookupConfig, context?: ProviderRequestContext): Promise<void> {
    throwIfProviderRequestAborted(context);
    try {
      await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}`,
        {
          method: 'DELETE',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        },
        undefined,
        undefined,
        context
      );
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return;
      }
      throw err;
    }
  }

  async getVolume(
    config: VolumeLookupConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance | null> {
    throwIfProviderRequestAborted(context);
    try {
      const response = await providerFetch(
        this.name,
        `${HETZNER_API_URL}/volumes/${config.volumeId}`,
        {
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        },
        undefined,
        undefined,
        context
      );

      throwIfProviderRequestAborted(context);
      const data = validateHetznerVolumeResponse(
        await parseProviderJson(response, this.name, 'getVolume'),
        'getVolume'
      );
      throwIfProviderRequestAborted(context);
      return mapHetznerVolumeToInstance(data.volume);
    } catch (err) {
      rethrowIfProviderRequestAborted(err, context);
      if (err instanceof ProviderError && err.statusCode === 404) {
        return null;
      }
      throw err;
    }
  }

  async listVolumes(
    config: VolumeListConfig,
    context?: ProviderRequestContext
  ): Promise<VolumeInstance[]> {
    throwIfProviderRequestAborted(context);
    const volumes: HetznerVolumePayload[] = [];

    await fetchPaginatedHetznerList({
      apiToken: this.apiToken,
      resource: 'volumes',
      baseParams: new URLSearchParams({ location: config.location }),
      operation: 'listVolumes',
      handlePage: (data) => {
        const validated = validateHetznerVolumesResponse(data, 'listVolumes');
        volumes.push(...validated.volumes);
        return validated.nextPage;
      },
      labelParts: hetznerLabelSelectorParts(config.labels),
      maxPages: this.maxListPages,
      context,
    });

    throwIfProviderRequestAborted(context);
    return volumes.map(mapHetznerVolumeToInstance);
  }

  private async getCurrentVolumeSize(
    config: VolumeResizeConfig,
    context?: ProviderRequestContext
  ): Promise<number> {
    throwIfProviderRequestAborted(context);
    const volume = await this.getVolume(
      { volumeId: config.volumeId, location: config.location },
      context
    );
    if (!volume) {
      throw new ProviderError(this.name, 404, `Hetzner volume ${config.volumeId} not found`, {
        category: 'invalid_config',
      });
    }
    return volume.sizeGb;
  }
}
