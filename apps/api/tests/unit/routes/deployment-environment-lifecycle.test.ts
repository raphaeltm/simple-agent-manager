/**
 * Unit tests for deployment environment lifecycle volume placement gating.
 *
 * resolveVolumePlacementConstraint is the gate that runs in the /start handler
 * before a deployment node is provisioned (deployment-environment-lifecycle.ts).
 * It must reject any environment whose provider-backed volumes do not all share
 * the same provider AND location, because a single VM can only attach volumes
 * that live in its own provider/location.
 */
import { describe, expect, it } from 'vitest';

import type { DeploymentVolumeRow } from '../../../src/db/schema';
import { resolveVolumePlacementConstraint } from '../../../src/routes/deployment-environment-lifecycle';

function makeVolume(overrides: Partial<DeploymentVolumeRow> = {}): DeploymentVolumeRow {
  return {
    id: 'vol-1',
    environmentId: 'env-1',
    name: 'data',
    providerVolumeId: 'prov-vol-1',
    providerName: 'hetzner',
    sizeGb: 10,
    location: 'nbg1',
    status: 'available',
    attachedServerId: null,
    linuxDevice: null,
    createdAt: '2026-06-30T00:00:00Z',
    updatedAt: '2026-06-30T00:00:00Z',
    ...overrides,
  } as DeploymentVolumeRow;
}

describe('resolveVolumePlacementConstraint', () => {
  it('returns null when there are no volumes', () => {
    expect(resolveVolumePlacementConstraint([])).toBeNull();
  });

  it('resolves provider and location from a single volume', () => {
    const constraint = resolveVolumePlacementConstraint([
      makeVolume({ providerName: 'hetzner', location: 'nbg1' }),
    ]);
    expect(constraint).toEqual({ provider: 'hetzner', location: 'nbg1' });
  });

  it('resolves when every volume shares the same provider and location', () => {
    const constraint = resolveVolumePlacementConstraint([
      makeVolume({ id: 'vol-1', name: 'data', providerName: 'hetzner', location: 'nbg1' }),
      makeVolume({ id: 'vol-2', name: 'uploads', providerName: 'hetzner', location: 'nbg1' }),
      makeVolume({ id: 'vol-3', name: 'cache', providerName: 'hetzner', location: 'nbg1' }),
    ]);
    expect(constraint).toEqual({ provider: 'hetzner', location: 'nbg1' });
  });

  it('rejects volumes that mix providers', () => {
    expect(() =>
      resolveVolumePlacementConstraint([
        makeVolume({ id: 'vol-1', providerName: 'hetzner', location: 'nbg1' }),
        makeVolume({ id: 'vol-2', providerName: 'scaleway', location: 'nbg1' }),
      ])
    ).toThrow(/same provider and location/);
  });

  it('rejects volumes that mix locations within the same provider', () => {
    expect(() =>
      resolveVolumePlacementConstraint([
        makeVolume({ id: 'vol-1', providerName: 'hetzner', location: 'nbg1' }),
        makeVolume({ id: 'vol-2', providerName: 'hetzner', location: 'fsn1' }),
      ])
    ).toThrow(/same provider and location/);
  });

  it('rejects when both provider and location diverge', () => {
    expect(() =>
      resolveVolumePlacementConstraint([
        makeVolume({ id: 'vol-1', providerName: 'hetzner', location: 'nbg1' }),
        makeVolume({ id: 'vol-2', providerName: 'scaleway', location: 'fr-par-1' }),
      ])
    ).toThrow(/same provider and location/);
  });

  it('rejects a divergent volume even when it is not adjacent to the first', () => {
    expect(() =>
      resolveVolumePlacementConstraint([
        makeVolume({ id: 'vol-1', providerName: 'hetzner', location: 'nbg1' }),
        makeVolume({ id: 'vol-2', providerName: 'hetzner', location: 'nbg1' }),
        makeVolume({ id: 'vol-3', providerName: 'hetzner', location: 'fsn1' }),
      ])
    ).toThrow(/same provider and location/);
  });
});
