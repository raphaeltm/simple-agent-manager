import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import { ScalewayProvider } from '../../src/scaleway';
import {
  SAM_VOLUME_FILESYSTEM_FORMAT,
  SAM_VOLUME_FSTAB_OPTIONS,
  SAM_VOLUME_MOUNT_PATH_TEMPLATE,
} from '../../src/types';
import { fetchCall, jsonBody } from './test-helpers';

const originalFetch = globalThis.fetch;

function hetznerVolume(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    name: 'sam-env-data',
    server: null,
    created: '2026-06-11T12:00:00Z',
    location: { name: 'fsn1' },
    size: 20,
    linux_device: null,
    labels: { environment: 'env-123' },
    status: 'available',
    ...overrides,
  };
}

function scalewayVolume(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vol-123',
    name: 'sam-env-data',
    size: 20_000_000_000,
    project_id: 'project-123',
    created_at: '2026-06-11T12:00:00Z',
    updated_at: '2026-06-11T12:00:00Z',
    references: [],
    status: 'available',
    tags: ['environment=env-123'],
    type: 'sbs_5k',
    zone: 'fr-par-1',
    ...overrides,
  };
}

describe('provider volume operations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('HetznerProvider', () => {
    it('exposes volume constraints and SAM lifecycle conventions', () => {
      const provider = new HetznerProvider('token', 'fsn1');

      expect(provider.volumeCapabilities).toMatchObject({
        supported: true,
        minSizeGb: 10,
        maxSizeGb: 10_000,
        growOnlyResize: true,
        requiresSameLocation: true,
        maxAttachedVolumesPerServer: 16,
        defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
      });
      expect(provider.volumeCapabilities.lifecycle).toEqual({
        filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
        mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
        fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
      });
    });

    it('creates ext4 volumes in the requested location with exact Hetzner payload', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ volume: hetznerVolume() }), { status: 201 }),
      );
      globalThis.fetch = mockFetch;

      const volume = await provider.createVolume({
        name: 'sam-env-data',
        sizeGb: 20,
        location: 'fsn1',
        labels: { environment: 'env-123' },
      });

      expect(fetchCall(mockFetch, 0).url).toBe('https://api.hetzner.cloud/v1/volumes');
      expect(fetchCall(mockFetch, 0).init.method).toBe('POST');
      expect(fetchCall(mockFetch, 0).init.headers).toMatchObject({
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
      });
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({
        name: 'sam-env-data',
        size: 20,
        location: 'fsn1',
        format: 'ext4',
        labels: { environment: 'env-123' },
      });
      expect(volume).toMatchObject({
        id: '123',
        name: 'sam-env-data',
        sizeGb: 20,
        location: 'fsn1',
        status: 'available',
      });
    });

    it('attaches volumes without provider automount', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 1 } }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          volume: hetznerVolume({
            server: { id: 456 },
            linux_device: '/dev/disk/by-id/scsi-0HC_Volume_123',
          }),
        }), { status: 200 }));
      globalThis.fetch = mockFetch;

      const volume = await provider.attachVolume({
        volumeId: '123',
        serverId: '456',
        location: 'fsn1',
      });

      expect(fetchCall(mockFetch, 0).url).toBe('https://api.hetzner.cloud/v1/volumes/123/actions/attach');
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({
        server: 456,
        automount: false,
      });
      expect(fetchCall(mockFetch, 1).url).toBe('https://api.hetzner.cloud/v1/volumes/123');
      expect(volume.attachedServerId).toBe('456');
      expect(volume.linuxDevice).toBe('/dev/disk/by-id/scsi-0HC_Volume_123');
    });

    it('resizes upward with exact Hetzner payload', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 1 } }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          volume: hetznerVolume({ size: 30 }),
        }), { status: 200 }));
      globalThis.fetch = mockFetch;

      const volume = await provider.resizeVolume({
        volumeId: '123',
        location: 'fsn1',
        currentSizeGb: 20,
        sizeGb: 30,
      });

      expect(fetchCall(mockFetch, 0).url).toBe('https://api.hetzner.cloud/v1/volumes/123/actions/resize');
      expect(fetchCall(mockFetch, 0).init.method).toBe('POST');
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({ size: 30 });
      expect(fetchCall(mockFetch, 1).url).toBe('https://api.hetzner.cloud/v1/volumes/123');
      expect(volume.sizeGb).toBe(30);
    });

    it('rejects volume sizes below the provider minimum before HTTP', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(provider.createVolume({
        name: 'too-small',
        sizeGb: 9,
        location: 'fsn1',
      })).rejects.toMatchObject({
        category: 'invalid_config',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('rejects shrink resize before HTTP when current size is supplied', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(provider.resizeVolume({
        volumeId: '123',
        location: 'fsn1',
        currentSizeGb: 20,
        sizeGb: 10,
      })).rejects.toThrow('Cannot shrink Hetzner volume');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('maps create errors to normalized provider categories', async () => {
      const provider = new HetznerProvider('token', 'fsn1');
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          error: {
            code: 'server_limit_exceeded',
            message: 'volume quota exceeded',
          },
        }), { status: 422 }),
      );

      await expect(provider.createVolume({
        name: 'quota',
        sizeGb: 20,
        location: 'fsn1',
      })).rejects.toMatchObject({
        providerName: 'hetzner',
        statusCode: 422,
        providerCode: 'server_limit_exceeded',
        category: 'quota_exceeded',
      });
    });
  });

  describe('ScalewayProvider', () => {
    it('exposes volume constraints, Scaleway gaps, and SAM lifecycle conventions', () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');

      expect(provider.volumeCapabilities).toMatchObject({
        supported: true,
        minSizeGb: 1,
        maxSizeGb: 10_000,
        growOnlyResize: true,
        requiresSameLocation: true,
        maxAttachedVolumesPerServer: 15,
        defaultFormat: SAM_VOLUME_FILESYSTEM_FORMAT,
      });
      expect(provider.volumeCapabilities.lifecycle).toEqual({
        filesystem: SAM_VOLUME_FILESYSTEM_FORMAT,
        mountPathTemplate: SAM_VOLUME_MOUNT_PATH_TEMPLATE,
        fstabOptions: SAM_VOLUME_FSTAB_OPTIONS,
      });
      expect(provider.volumeCapabilities.notes?.join(' ')).toContain('format ext4');
    });

    it('creates block volumes in the requested zone with exact Scaleway payload', async () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(scalewayVolume()), { status: 200 }),
      );
      globalThis.fetch = mockFetch;

      const volume = await provider.createVolume({
        name: 'sam-env-data',
        sizeGb: 20,
        location: 'fr-par-1',
        labels: { environment: 'env-123' },
      });

      expect(fetchCall(mockFetch, 0).url).toBe('https://api.scaleway.com/block/v1/zones/fr-par-1/volumes');
      expect(fetchCall(mockFetch, 0).init.method).toBe('POST');
      expect(fetchCall(mockFetch, 0).init.headers).toMatchObject({
        'X-Auth-Token': 'secret',
        'Content-Type': 'application/json',
      });
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({
        name: 'sam-env-data',
        project_id: 'project-123',
        perf_iops: 5_000,
        from_empty: { size: 20_000_000_000 },
        tags: ['environment=env-123'],
      });
      expect(volume).toMatchObject({
        id: 'vol-123',
        name: 'sam-env-data',
        sizeGb: 20,
        location: 'fr-par-1',
        status: 'available',
        volumeType: 'sbs_5k',
      });
    });

    it('attaches block volumes through the Scaleway Instance API in the same zone', async () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');
      const mockFetch = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ server: {} }), { status: 200 }))
        .mockResolvedValueOnce(new Response(JSON.stringify(scalewayVolume({
          references: [{ id: 'server-123', type: 'instance_server', status: 'attached' }],
          status: 'in_use',
        })), { status: 200 }));
      globalThis.fetch = mockFetch;

      const volume = await provider.attachVolume({
        volumeId: 'vol-123',
        serverId: 'server-123',
        location: 'fr-par-1',
      });

      expect(fetchCall(mockFetch, 0).url).toBe(
        'https://api.scaleway.com/instance/v1/zones/fr-par-1/servers/server-123/attach-volume',
      );
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({
        volume_id: 'vol-123',
        volume_type: 'sbs_volume',
        boot: false,
      });
      expect(fetchCall(mockFetch, 1).url).toBe(
        'https://api.scaleway.com/block/v1/zones/fr-par-1/volumes/vol-123',
      );
      expect(volume.status).toBe('attached');
      expect(volume.attachedServerId).toBe('server-123');
    });

    it('rejects shrink resize before HTTP when current size is supplied', async () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');
      const mockFetch = vi.fn();
      globalThis.fetch = mockFetch;

      await expect(provider.resizeVolume({
        volumeId: 'vol-123',
        location: 'fr-par-1',
        currentSizeGb: 20,
        sizeGb: 10,
      })).rejects.toThrow('Cannot shrink Scaleway volume');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resizes upward with byte-sized Scaleway payload', async () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');
      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify(scalewayVolume({ size: 30_000_000_000 })), { status: 200 }),
      );
      globalThis.fetch = mockFetch;

      const volume = await provider.resizeVolume({
        volumeId: 'vol-123',
        location: 'fr-par-1',
        currentSizeGb: 20,
        sizeGb: 30,
      });

      expect(fetchCall(mockFetch, 0).url).toBe('https://api.scaleway.com/block/v1/zones/fr-par-1/volumes/vol-123');
      expect(fetchCall(mockFetch, 0).init.method).toBe('PATCH');
      expect(jsonBody(fetchCall(mockFetch, 0).init)).toEqual({ size: 30_000_000_000 });
      expect(volume.sizeGb).toBe(30);
    });

    it('maps create errors to normalized provider categories', async () => {
      const provider = new ScalewayProvider('secret', 'project-123', 'fr-par-1');
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({
          type: 'quota_exceeded',
          message: 'volume quota exceeded',
        }), { status: 403 }),
      );

      await expect(provider.createVolume({
        name: 'quota',
        sizeGb: 20,
        location: 'fr-par-1',
      })).rejects.toMatchObject({
        providerName: 'scaleway',
        statusCode: 403,
        providerCode: 'quota_exceeded',
        category: 'quota_exceeded',
      });
    });
  });
});
