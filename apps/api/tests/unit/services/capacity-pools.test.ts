import { describe, expect, it } from 'vitest';

import type * as schema from '../../../src/db/schema';
import {
  toCapacityPlacementSnapshot,
  toCapacityPool,
  toCapacityPoolCandidate,
  toCapacitySourceIdentity,
} from '../../../src/services/capacity-pools';

const now = '2026-08-27T00:00:00.000Z';

function makeSource(overrides: Partial<schema.CapacitySource> = {}): schema.CapacitySource {
  return {
    id: 'source-1',
    scope: 'project',
    ownerUserId: null,
    ownerProjectId: 'project-1',
    sourceKind: 'cloud-provider-credential',
    provider: 'hetzner',
    credentialSource: 'project',
    credentialId: 'credential-1',
    platformCredentialId: null,
    credentialReference: 'credentials:credential-1',
    credentialVersion: 4,
    externalSourceRef: null,
    status: 'active',
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makePool(overrides: Partial<schema.CapacityPool> = {}): schema.CapacityPool {
  return {
    id: 'pool-1',
    scope: 'project',
    ownerUserId: null,
    ownerProjectId: 'project-1',
    name: 'Project default',
    isDefault: true,
    revision: 9,
    status: 'active',
    strategy: 'pack',
    exhaustionPolicy: 'queue',
    createdBy: 'user-1',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCandidate(
  overrides: Partial<schema.CapacityPoolCandidate> = {}
): schema.CapacityPoolCandidate {
  return {
    id: 'candidate-1',
    poolId: 'pool-1',
    capacitySourceId: 'source-1',
    provider: 'hetzner',
    location: 'nbg1',
    workloadRole: 'workspace',
    runtime: 'vm',
    machineClass: 'shared-vm',
    machineSize: 'medium',
    providerInstanceType: 'cx33',
    providerInstanceSku: null,
    providerInstanceDisplayName: 'cx33 · 4 vCPU · 8 GB RAM · 80 GB disk',
    providerInstanceVcpuCount: 4,
    providerInstanceMemoryMb: 8192,
    providerInstanceDiskGb: 80,
    providerInstancePriceDisplay: '€7.49/mo',
    providerInstancePriceCurrency: 'EUR',
    providerInstancePriceMonthlyCents: 749,
    providerInstancePriceHourlyMicros: 10260,
    providerInstanceCatalogSource: 'static',
    providerInstanceCatalogLastSeenAt: null,
    priority: 10,
    candidateOrder: 0,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('capacity pool mappers', () => {
  it('maps capacity source identity without secret fields', () => {
    const mapped = toCapacitySourceIdentity(makeSource());

    expect(mapped).toEqual({
      id: 'source-1',
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: 'project-1',
      sourceKind: 'cloud-provider-credential',
      provider: 'hetzner',
      credentialSource: 'project',
      credentialId: 'credential-1',
      platformCredentialId: null,
      credentialReference: 'credentials:credential-1',
      credentialVersion: 4,
      externalSourceRef: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    expect(mapped).not.toHaveProperty('encryptedToken');
    expect(mapped).not.toHaveProperty('iv');
  });

  it('maps pool default/revision/strategy/exhaustion policy fields', () => {
    expect(toCapacityPool(makePool())).toMatchObject({
      id: 'pool-1',
      scope: 'project',
      ownerProjectId: 'project-1',
      isDefault: true,
      revision: 9,
      status: 'active',
      strategy: 'pack',
      exhaustionPolicy: 'queue',
    });
  });

  it('maps candidate source/provider/location/machine ranking fields', () => {
    expect(toCapacityPoolCandidate(makeCandidate())).toMatchObject({
      id: 'candidate-1',
      poolId: 'pool-1',
      capacitySourceId: 'source-1',
      provider: 'hetzner',
      location: 'nbg1',
      workloadRole: 'workspace',
      runtime: 'vm',
      machineClass: 'shared-vm',
      machineSize: 'medium',
      providerInstanceType: 'cx33',
      providerInstanceSku: null,
      providerInstanceDisplayName: 'cx33 · 4 vCPU · 8 GB RAM · 80 GB disk',
      providerInstanceVcpuCount: 4,
      providerInstanceMemoryMb: 8192,
      providerInstanceDiskGb: 80,
      providerInstancePriceDisplay: '€7.49/mo',
      providerInstancePriceCurrency: 'EUR',
      providerInstancePriceMonthlyCents: 749,
      providerInstancePriceHourlyMicros: 10260,
      providerInstanceCatalogSource: 'static',
      providerInstanceCatalogLastSeenAt: null,
      priority: 10,
      candidateOrder: 0,
    });
  });

  it('maps nullable placement snapshots for legacy rows', () => {
    expect(
      toCapacityPlacementSnapshot({
        capacityPoolId: null,
        capacityPoolScope: null,
        capacityPoolRevision: null,
        capacitySourceId: null,
        capacityPoolCandidateId: null,
        placementCredentialSource: null,
        placementCredentialReference: null,
        placementCredentialVersion: null,
        capacityPoolProjectId: null,
        workloadRole: null,
      })
    ).toEqual({
      capacityPoolId: null,
      capacityPoolScope: null,
      capacityPoolRevision: null,
      capacitySourceId: null,
      capacityPoolCandidateId: null,
      placementCredentialSource: null,
      placementCredentialReference: null,
      placementCredentialVersion: null,
      capacityPoolProjectId: null,
      workloadRole: null,
      providerInstanceType: null,
      providerInstanceVcpuCount: null,
      providerInstanceMemoryMb: null,
      providerInstanceDiskGb: null,
      providerInstancePriceDisplay: null,
      providerInstancePriceCurrency: null,
      providerInstancePriceMonthlyCents: null,
      providerInstancePriceHourlyMicros: null,
      placementExplanationJson: null,
    });
  });

  it('rejects invalid persisted enum strings instead of silently coercing them', () => {
    expect(() => toCapacityPool(makePool({ scope: 'workspace' }))).toThrow(
      'Invalid persisted capacity_pools.scope: workspace'
    );
    expect(() => toCapacitySourceIdentity(makeSource({ credentialSource: 'self-hosted' }))).toThrow(
      'Invalid persisted capacity_sources.credential_source: self-hosted'
    );
    expect(() => toCapacityPoolCandidate(makeCandidate({ workloadRole: 'agent-session' }))).toThrow(
      'Invalid persisted capacity_pool_candidates.workload_role: agent-session'
    );
    expect(() =>
      toCapacityPoolCandidate(makeCandidate({ providerInstanceCatalogSource: 'manual' }))
    ).toThrow('Invalid persisted capacity_pool_candidates.provider_instance_catalog_source: manual');
    expect(() =>
      toCapacityPlacementSnapshot({
        capacityPoolId: 'pool-1',
        capacityPoolScope: 'tenant',
        capacityPoolRevision: 1,
        capacitySourceId: 'source-1',
        placementCredentialSource: 'project',
        placementCredentialReference: 'credentials:credential-1',
        placementCredentialVersion: 1,
        capacityPoolProjectId: 'project-1',
        workloadRole: 'workspace',
      })
    ).toThrow('Invalid persisted capacity_pool_scope: tenant');
  });
});
