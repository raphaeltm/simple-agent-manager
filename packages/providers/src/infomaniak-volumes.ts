/**
 * Cinder data volumes for Infomaniak, managed separately from the VM and its boot volume. Boot
 * volumes are created by Nova (infomaniak-boot-volume.ts) and carry no SAM labels, so label-scoped
 * volume operations here never select them.
 */
import {
  asArray,
  asNumber,
  asRecord,
  asString,
  INFOMANIAK_VOLUME_MAX_SIZE_GB,
  INFOMANIAK_VOLUME_MIN_SIZE_GB,
  infomaniakMetadata,
  infomaniakVolumeStatus,
} from './infomaniak-metadata';
import { throwIfProviderRequestAborted } from './provider-fetch';
import {
  ProviderError,
  type ProviderRequestContext,
  type VolumeAttachmentConfig,
  type VolumeConfig,
  type VolumeDetachConfig,
  type VolumeInstance,
  type VolumeListConfig,
  type VolumeLookupConfig,
  type VolumeResizeConfig,
} from './types';

/** The authenticated OpenStack session the volume operations run on (`InfomaniakProvider`). */
export interface InfomaniakApi {
  readonly region: string;
  readonly volumeType: string;
  endpoints(context?: ProviderRequestContext): Promise<{ compute: string; volumev3: string }>;
  request(
    url: string,
    init?: RequestInit,
    allow404?: boolean,
    context?: ProviderRequestContext
  ): Promise<Response | null>;
}

function parseInfomaniakVolume(value: unknown, region: string): VolumeInstance {
  const volume = asRecord(value, 'volume');
  const attachments = Array.isArray(volume.attachments)
    ? volume.attachments.map((value) => asRecord(value, 'attachment'))
    : [];
  const id = asString(volume.id, 'volume.id');
  const attachment = attachments[0];
  return {
    id,
    name: typeof volume.name === 'string' && volume.name ? volume.name : id,
    sizeGb: asNumber(volume.size, 'volume.size'),
    location: region,
    status: infomaniakVolumeStatus(asString(volume.status, 'volume.status')),
    attachedServerId: typeof attachment?.server_id === 'string' ? attachment.server_id : undefined,
    linuxDevice: `/dev/disk/by-id/scsi-0QEMU_QEMU_HARDDISK_${id.slice(0, 20)}`,
    volumeType: typeof volume.volume_type === 'string' ? volume.volume_type : undefined,
    createdAt: asString(volume.created_at, 'volume.created_at'),
    labels: infomaniakMetadata(volume.metadata),
  };
}
export async function createInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance> {
  throwIfProviderRequestAborted(context);
  if (config.location !== api.region)
    throw new ProviderError('infomaniak', 400, 'Volume and credential regions must match', {
      category: 'invalid_config',
    });
  if (
    config.sizeGb < INFOMANIAK_VOLUME_MIN_SIZE_GB ||
    config.sizeGb > INFOMANIAK_VOLUME_MAX_SIZE_GB
  )
    throw new ProviderError(
      'infomaniak',
      400,
      [
        'Volume size must be between',
        INFOMANIAK_VOLUME_MIN_SIZE_GB,
        'and',
        INFOMANIAK_VOLUME_MAX_SIZE_GB,
        'GB',
      ].join(' '),
      {
        category: 'invalid_config',
      }
    );
  const s = await api.endpoints(context);
  const r = await api.request(
    `${s.volumev3}/volumes`,
    {
      method: 'POST',
      body: JSON.stringify({
        volume: {
          name: config.name,
          size: config.sizeGb,
          volume_type: api.volumeType,
          metadata: config.labels ?? {},
        },
      }),
    },
    false,
    context
  );
  return parseInfomaniakVolume(asRecord(await r?.json(), 'root').volume, api.region);
}
export async function getInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeLookupConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance | null> {
  throwIfProviderRequestAborted(context);
  const s = await api.endpoints(context);
  const r = await api.request(`${s.volumev3}/volumes/${config.volumeId}`, {}, true, context);
  return r ? parseInfomaniakVolume(asRecord(await r.json(), 'root').volume, api.region) : null;
}
export async function listInfomaniakVolumes(
  api: InfomaniakApi,
  config: VolumeListConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance[]> {
  throwIfProviderRequestAborted(context);
  const s = await api.endpoints(context);
  const r = await api.request(`${s.volumev3}/volumes/detail`, {}, false, context);
  const values = asArray(asRecord(await r?.json(), 'root').volumes, 'volumes').map((value) =>
    parseInfomaniakVolume(value, api.region)
  );
  return config.labels
    ? values.filter((volume) =>
        Object.entries(config.labels ?? {}).every(([key, value]) => volume.labels[key] === value)
      )
    : values;
}
export async function deleteInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeLookupConfig,
  context?: ProviderRequestContext
): Promise<void> {
  throwIfProviderRequestAborted(context);
  const current = await getInfomaniakVolume(api, config, context);
  if (!current) return;
  if (current.attachedServerId)
    throw new ProviderError('infomaniak', 409, 'Refusing to delete an attached Infomaniak volume', {
      category: 'invalid_config',
    });
  throwIfProviderRequestAborted(context);
  const s = await api.endpoints(context);
  await api.request(
    `${s.volumev3}/volumes/${config.volumeId}`,
    { method: 'DELETE' },
    true,
    context
  );
}
export async function attachInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeAttachmentConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance> {
  throwIfProviderRequestAborted(context);
  if (config.location !== api.region)
    throw new ProviderError('infomaniak', 400, 'Server and volume regions must match', {
      category: 'invalid_config',
    });
  const s = await api.endpoints(context);
  await api.request(
    `${s.compute}/servers/${config.serverId}/os-volume_attachments`,
    {
      method: 'POST',
      body: JSON.stringify({ volumeAttachment: { volumeId: config.volumeId } }),
    },
    false,
    context
  );
  const result = await getInfomaniakVolume(api, config, context);
  if (!result) throw new ProviderError('infomaniak', 404, 'Attached volume was not found');
  return result;
}
export async function detachInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeDetachConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance | null> {
  throwIfProviderRequestAborted(context);
  const current = await getInfomaniakVolume(api, config, context);
  if (!current?.attachedServerId) return current;
  const serverId = config.serverId ?? current.attachedServerId;
  const s = await api.endpoints(context);
  const r = await api.request(
    `${s.compute}/servers/${serverId}/os-volume_attachments`,
    {},
    false,
    context
  );
  const attachments = asArray(
    asRecord(await r?.json(), 'root').volumeAttachments,
    'volumeAttachments'
  ).map((value) => asRecord(value, 'attachment'));
  const match = attachments.find((item) => item.volumeId === config.volumeId);
  throwIfProviderRequestAborted(context);
  if (match)
    await api.request(
      `${s.compute}/servers/${serverId}/os-volume_attachments/${asString(match.id, 'attachment.id')}`,
      { method: 'DELETE' },
      true,
      context
    );
  return getInfomaniakVolume(api, config, context);
}
export async function resizeInfomaniakVolume(
  api: InfomaniakApi,
  config: VolumeResizeConfig,
  context?: ProviderRequestContext
): Promise<VolumeInstance> {
  throwIfProviderRequestAborted(context);
  const current = await getInfomaniakVolume(api, config, context);
  if (!current)
    throw new ProviderError('infomaniak', 404, 'Volume not found', {
      category: 'invalid_config',
    });
  if (config.sizeGb <= (config.currentSizeGb ?? current.sizeGb))
    throw new ProviderError('infomaniak', 400, 'Infomaniak volumes can only be grown', {
      category: 'invalid_config',
    });
  if (current.attachedServerId)
    throw new ProviderError('infomaniak', 409, 'Detach the Infomaniak volume before resizing', {
      category: 'invalid_config',
    });
  throwIfProviderRequestAborted(context);
  const s = await api.endpoints(context);
  await api.request(
    `${s.volumev3}/volumes/${config.volumeId}/action`,
    {
      method: 'POST',
      body: JSON.stringify({ 'os-extend': { new_size: config.sizeGb } }),
    },
    false,
    context
  );
  const result = await getInfomaniakVolume(api, config, context);
  if (!result) throw new ProviderError('infomaniak', 404, 'Resized volume was not found');
  return result;
}
