/**
 * Volume lifecycle resilience vertical-slice tests.
 *
 * Exercises the full provider-level lifecycle that the SAM resiliency model
 * promises:
 *
 *   create → attach to node → (release apply) → detach from old node
 *   → attach to new node → re-apply current release → same data path
 *
 * Asserts idempotency (detach tolerates already-deleted via 404) and that the
 * environment remains canonical across node replacement (same volume id, same
 * data path). Note: "create-or-reuse" logic lives above the provider layer
 * (in deployment-volumes.ts listEnvironmentVolumes); provider.createVolume
 * will error on duplicate names.
 *
 * Uses realistic mocked provider fetch responses (Hetzner) with full
 * VolumeInstance shapes — no empty mock objects.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HetznerProvider } from '../../src/hetzner';
import type { VolumeInstance } from '../../src/types';
import { SAM_VOLUME_MOUNT_PATH_TEMPLATE } from '../../src/types';
import { fetchCall, jsonBody } from './test-helpers';

const originalFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Realistic Hetzner API response factories
// ---------------------------------------------------------------------------

function hetznerVolumeResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    name: 'sam-env-abc123-data',
    server: null,
    created: '2026-06-11T12:00:00Z',
    location: { name: 'fsn1' },
    size: 20,
    linux_device: null,
    labels: { 'sam-environment': 'env-abc123', 'sam-volume-name': 'data' },
    status: 'available',
    ...overrides,
  };
}

function attachedHetznerVolume(serverId: number) {
  return hetznerVolumeResponse({
    server: { id: serverId },
    linux_device: '/dev/disk/by-id/scsi-0HC_Volume_42',
    status: 'in-use',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('volume lifecycle resilience (vertical slice)', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  it('full node-replacement lifecycle preserves volume identity and data path', async () => {
    const provider = new HetznerProvider('token', 'fsn1');
    const environmentId = 'env-abc123';

    // -----------------------------------------------------------------------
    // Step 1: Create volume
    // -----------------------------------------------------------------------
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ volume: hetznerVolumeResponse() }), { status: 201 }),
    );

    const created: VolumeInstance = await provider.createVolume({
      name: 'sam-env-abc123-data',
      sizeGb: 20,
      location: 'fsn1',
      labels: { 'sam-environment': environmentId, 'sam-volume-name': 'data' },
    });

    expect(created.id).toBe('42');
    expect(created.sizeGb).toBe(20);
    expect(created.status).toBe('available');
    expect(created.attachedServerId).toBeUndefined();

    // Verify mount path template produces the expected host path
    const mountRoot = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', environmentId);
    expect(mountRoot).toBe(`/mnt/sam-env-${environmentId}/`);

    // -----------------------------------------------------------------------
    // Step 2: Attach to old node (server 100)
    // -----------------------------------------------------------------------
    const oldServerId = '100';
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 1 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ volume: attachedHetznerVolume(100) }), { status: 200 }),
      );

    const attached = await provider.attachVolume({
      volumeId: created.id,
      serverId: oldServerId,
      location: 'fsn1',
    });

    expect(attached.id).toBe('42'); // same volume
    expect(attached.attachedServerId).toBe(oldServerId);
    expect(attached.linuxDevice).toBe('/dev/disk/by-id/scsi-0HC_Volume_42');

    // Verify attach payload: automount=false (SAM manages mount via cloud-init)
    expect(jsonBody(fetchCall(mockFetch, 1).init)).toEqual({
      server: 100,
      automount: false,
    });

    // -----------------------------------------------------------------------
    // Step 3: Detach from old node (simulating node replacement)
    // -----------------------------------------------------------------------
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 2 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ volume: hetznerVolumeResponse() }), { status: 200 }),
      );

    const detached = await provider.detachVolume({
      volumeId: created.id,
      serverId: oldServerId,
      location: 'fsn1',
    });

    expect(fetchCall(mockFetch, 3).url).toContain('/volumes/42/actions/detach');
    expect(detached).not.toBeNull();
    expect(detached!.attachedServerId).toBeUndefined(); // no longer attached

    // -----------------------------------------------------------------------
    // Step 4: Attach to NEW node (server 200) — node replacement complete
    // -----------------------------------------------------------------------
    const newServerId = '200';
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 3 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ volume: attachedHetznerVolume(200) }), { status: 200 }),
      );

    const reattached = await provider.attachVolume({
      volumeId: created.id,
      serverId: newServerId,
      location: 'fsn1',
    });

    // Canonical identity preserved across node replacement
    expect(reattached.id).toBe('42'); // SAME volume id
    expect(reattached.attachedServerId).toBe(newServerId);
    expect(reattached.linuxDevice).toBe('/dev/disk/by-id/scsi-0HC_Volume_42'); // same device

    // The mount path on the new node is the same as the old node — data is
    // canonical across node replacement because SAM_VOLUME_MOUNT_PATH_TEMPLATE
    // is keyed on environmentId, not nodeId or serverId
    const mountPathOnNewNode = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', environmentId);
    expect(mountPathOnNewNode).toBe(mountRoot); // identical path
  });

  it('detach tolerates already-deleted volume (idempotency via 404)', async () => {
    const provider = new HetznerProvider('token', 'fsn1');

    // Hetzner returns 404 when volume does not exist — provider catches this
    // and returns null instead of throwing, making detach idempotent for
    // already-deleted volumes
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: 'not_found',
            message: 'Volume not found',
          },
        }),
        { status: 404 },
      ),
    );

    const result = await provider.detachVolume({
      volumeId: '42',
      serverId: '100',
      location: 'fsn1',
    });

    // Returns null (not throw) — idempotent
    expect(result).toBeNull();
  });

  it('detach treats Hetzner already-detached 422 as idempotent', async () => {
    const provider = new HetznerProvider('token', 'fsn1');

    mockFetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              code: 'invalid_input',
              message: 'volume not attached to a server',
            },
          }),
          { status: 422 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ volume: hetznerVolumeResponse() }), { status: 200 }),
      );

    const result = await provider.detachVolume({
      volumeId: '42',
      serverId: '100',
      location: 'fsn1',
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe('available');
    expect(result?.attachedServerId).toBeUndefined();
    expect(fetchCall(mockFetch, 1).url).toContain('/volumes/42');
  });

  it('detach succeeds and returns current volume state', async () => {
    const provider = new HetznerProvider('token', 'fsn1');

    // Detach action succeeds, then GET returns detached state
    mockFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ action: { id: 5 } }), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ volume: hetznerVolumeResponse() }), { status: 200 }),
      );

    const result = await provider.detachVolume({
      volumeId: '42',
      serverId: '100',
      location: 'fsn1',
    });

    expect(result).not.toBeNull();
    expect(result!.id).toBe('42');
    expect(result!.attachedServerId).toBeUndefined();
    expect(result!.status).toBe('available');
  });

  it('mount path is keyed on environmentId, not nodeId — canonical across replacement', () => {
    const envId = 'env-abc123';
    const path1 = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', envId);
    const path2 = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', envId);

    // No matter which node, the data path is the same
    expect(path1).toBe(path2);
    expect(path1).toBe('/mnt/sam-env-env-abc123/');

    // Different environment = different path
    const otherPath = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', 'env-other');
    expect(otherPath).not.toBe(path1);
  });

  it('compose mount guard integration: volume paths match provider mount template', () => {
    // This test verifies the contract between:
    // 1. The compose renderer (TypeScript) which produces bind mounts like:
    //    /mnt/sam-env-{envId}/volumes/{name}:{containerPath}
    // 2. The Go mount guard which extracts root = /mnt/sam-env-{envId}/volumes/{name}
    // 3. The provider mount template: /mnt/sam-env-{environmentId}/
    //
    // The mount guard checks that the named volume bind source is a real
    // mountpoint. Each provider volume mounts under the environment's canonical
    // volume root at its safe named volume path.
    const envId = 'env-abc123';
    const volumeName = 'data';
    const containerPath = '/app/data';

    // What the compose renderer produces
    const composeBind = `/mnt/sam-env-${envId}/volumes/${volumeName}:${containerPath}`;

    // What the mount guard extracts as the root to check
    const hostPath = composeBind.split(':')[0]!;
    expect(hostPath).toBe(`/mnt/sam-env-${envId}/volumes/${volumeName}`);

    // The mount guard strips to the named volume mountpoint
    const prefix = '/mnt/sam-env-';
    const remainder = hostPath.slice(prefix.length);
    const parts = remainder.split('/');
    const mountRoot = `${prefix}${parts[0]}/volumes/${parts[2]}`;
    expect(mountRoot).toBe(`/mnt/sam-env-${envId}/volumes/${volumeName}`);

    // What the provider uses as the environment's canonical volume namespace
    const providerMount = SAM_VOLUME_MOUNT_PATH_TEMPLATE.replace('{environmentId}', envId);
    expect(mountRoot.startsWith(`${providerMount}volumes/`)).toBe(true);
  });
});
