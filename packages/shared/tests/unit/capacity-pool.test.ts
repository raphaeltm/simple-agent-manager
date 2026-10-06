import { describe, expect, it } from 'vitest';

import {
  CAPACITY_CREDENTIAL_SOURCES,
  CAPACITY_EXHAUSTION_POLICIES,
  CAPACITY_PLACEMENT_CREDENTIAL_SOURCES,
  CAPACITY_POOL_SCOPES,
  CAPACITY_POOL_STATUSES,
  CAPACITY_POOL_STRATEGIES,
  CAPACITY_SOURCE_KINDS,
  CAPACITY_WORKLOAD_ROLES,
  type CapacityPlacementSnapshot,
  type CapacityPool,
  type CapacitySourceIdentity,
  isCapacityCredentialSource,
  isCapacityExhaustionPolicy,
  isCapacityPlacementCredentialSource,
  isCapacityPoolScope,
  isCapacityPoolStatus,
  isCapacityPoolStrategy,
  isCapacitySourceKind,
  isCapacityWorkloadRole,
} from '../../src/types';

describe('capacity pool shared types', () => {
  it('captures the v1 pool scopes and default-policy vocabulary', () => {
    expect(CAPACITY_POOL_SCOPES).toEqual(['installation', 'user', 'project']);
    expect(CAPACITY_POOL_STATUSES).toEqual(['active', 'disabled', 'deleted']);
    expect(CAPACITY_POOL_STRATEGIES).toEqual(['balanced', 'pack', 'spread', 'smallest-fit']);
    expect(CAPACITY_EXHAUSTION_POLICIES).toEqual(['queue', 'fail', 'fallback-chain']);
  });

  it('separates credential-backed capacity sources from future source kinds', () => {
    expect(CAPACITY_SOURCE_KINDS).toEqual([
      'cloud-provider-credential',
      'registered-runner',
      'instant-runtime',
    ]);
    expect(CAPACITY_CREDENTIAL_SOURCES).toEqual(['user', 'project', 'platform']);
    expect(CAPACITY_PLACEMENT_CREDENTIAL_SOURCES).toEqual([
      'user',
      'project',
      'platform',
      'self-hosted',
    ]);
    expect(CAPACITY_WORKLOAD_ROLES).toEqual(['workspace', 'deployment']);
  });

  it('provides runtime guards for persisted enum values', () => {
    expect(isCapacityPoolScope('project')).toBe(true);
    expect(isCapacityPoolScope('workspace')).toBe(false);
    expect(isCapacitySourceKind('registered-runner')).toBe(true);
    expect(isCapacitySourceKind('cloudflare-tunnel')).toBe(false);
    expect(isCapacityCredentialSource('platform')).toBe(true);
    expect(isCapacityCredentialSource('self-hosted')).toBe(false);
    expect(isCapacityPlacementCredentialSource('self-hosted')).toBe(true);
    expect(isCapacityPoolStatus('disabled')).toBe(true);
    expect(isCapacityPoolStatus('pending')).toBe(false);
    expect(isCapacityPoolStrategy('smallest-fit')).toBe(true);
    expect(isCapacityPoolStrategy('largest')).toBe(false);
    expect(isCapacityExhaustionPolicy('fallback-chain')).toBe(true);
    expect(isCapacityExhaustionPolicy('prompt-user')).toBe(false);
    expect(isCapacityWorkloadRole('deployment')).toBe(true);
    expect(isCapacityWorkloadRole('agent-session')).toBe(false);
  });

  it('models a default project pool without requiring secret material', () => {
    const source: CapacitySourceIdentity = {
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
      credentialVersion: 3,
      externalSourceRef: null,
      status: 'active',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const pool: CapacityPool = {
      id: 'pool-1',
      scope: 'project',
      ownerUserId: null,
      ownerProjectId: 'project-1',
      name: 'Project default',
      isDefault: true,
      revision: 7,
      status: 'active',
      strategy: 'pack',
      exhaustionPolicy: 'queue',
      createdAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    };
    const snapshot: CapacityPlacementSnapshot = {
      capacityPoolId: pool.id,
      capacityPoolScope: pool.scope,
      capacityPoolRevision: pool.revision,
      capacitySourceId: source.id,
      placementCredentialSource: 'project',
      placementCredentialReference: source.credentialReference,
      placementCredentialVersion: source.credentialVersion,
      capacityPoolProjectId: 'project-1',
      workloadRole: 'workspace',
      placementExplanationJson: '{"reason":"project default"}',
    };

    expect(source).not.toHaveProperty('encryptedToken');
    expect(source).not.toHaveProperty('iv');
    expect(snapshot.capacityPoolProjectId).toBe('project-1');
  });
});
