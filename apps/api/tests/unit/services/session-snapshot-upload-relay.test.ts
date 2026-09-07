import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import {
  buildSessionSnapshotRelayUploadUrl,
  ensureSessionSnapshotUploadRelay,
  findSessionSnapshotUploadRelay,
  resolveSessionSnapshotUploadTargets,
  verifySessionSnapshotRelayAuthorization,
} from '../../../src/services/session-snapshot-upload-relay';

const mocks = vi.hoisted(() => ({
  assertRelayProvisioningAuthority: vi.fn(),
  checkQuotaForUser: vi.fn(),
  cleanupFreshProvisioningNode: vi.fn(),
  createNodeRecord: vi.fn(),
  markIdle: vi.fn(),
  placementProjectDefaultsFromRow: vi.fn(),
  provisionNode: vi.fn(),
  resolveCanonicalVmAllocationPlan: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../../src/services/canonical-vm-allocation', () => ({
  placementProjectDefaultsFromRow: mocks.placementProjectDefaultsFromRow,
  resolveCanonicalVmAllocationPlan: mocks.resolveCanonicalVmAllocationPlan,
}));
vi.mock('../../../src/services/compute-quotas', () => ({
  checkQuotaForUser: mocks.checkQuotaForUser,
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/provisioning-authority', () => ({
  assertRelayProvisioningAuthority: mocks.assertRelayProvisioningAuthority,
  cleanupFreshProvisioningNode: mocks.cleanupFreshProvisioningNode,
}));
vi.mock('../../../src/services/jwt', () => ({
  verifyCallbackToken: mocks.verifyCallbackToken,
}));
vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type FirstResolver = (sql: string, values: unknown[]) => unknown;

function makeEnv(resolveFirst: FirstResolver): Env {
  const database = {
    prepare: vi.fn((sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => resolveFirst(sql, values),
      }),
    })),
  } as unknown as D1Database;
  return {
    DATABASE: database,
    BASE_DOMAIN: 'example.test',
    VM_AGENT_PROTOCOL: 'https',
    VM_AGENT_PORT: '8443',
    VM_AGENT_REQUIRED_VERSION: 'abcdef1234567890',
    MAX_NODES_PER_USER: '2',
    COMPUTE_QUOTA_ENFORCEMENT_ENABLED: 'true',
    NODE_LIFECYCLE: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => ({ markIdle: mocks.markIdle })),
    },
  } as unknown as Env;
}

function canonicalAllocation(overrides: Record<string, unknown> = {}) {
  return {
    placement: { workloadRole: 'workspace' },
    credential: { credentialSource: 'platform', providerName: 'hetzner' },
    quotaCredentialSource: 'platform',
    credentialAttributionUserId: 'user-1',
    credentialAttributionProjectId: null,
    credentialAttributionSource: 'platform',
    effectiveProvider: 'hetzner',
    vmSize: 'medium',
    vmLocation: 'nbg1',
    providerInstanceType: 'cx22',
    providerInstanceBootDiskSizeGb: null,
    providerInstanceImage: null,
    providerInstanceArchitecture: null,
    capacityPoolSelection: null,
    capacityPlacementSnapshot: null,
    ...overrides,
  };
}

function projectDefaultsRow() {
  return {
    id: 'project-1',
    defaultVmSize: 'medium',
    defaultProvider: 'hetzner',
    defaultLocation: 'nbg1',
    defaultWorkspaceProfile: 'lightweight',
    defaultDevcontainerConfigName: null,
    defaultAgentType: null,
  };
}

function sourceNode(agentVersion = 'legacy-version') {
  return {
    id: 'legacy-node',
    user_id: 'user-1',
    vm_size: 'medium',
    vm_location: 'nbg1',
    cloud_provider: 'hetzner',
    runtime: 'vm',
    node_class: 'managed',
    agent_version: agentVersion,
    provider_instance_type: 'cx22',
    provider_instance_boot_disk_size_gb: null,
    provider_instance_image: null,
    provider_instance_architecture: null,
  };
}

describe('session snapshot upload relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.placementProjectDefaultsFromRow.mockImplementation((project) => project);
    mocks.resolveCanonicalVmAllocationPlan.mockResolvedValue(canonicalAllocation());
    mocks.checkQuotaForUser.mockResolvedValue({ allowed: true });
    mocks.assertRelayProvisioningAuthority.mockResolvedValue(undefined);
    mocks.cleanupFreshProvisioningNode.mockResolvedValue('placeholder-deleted');
    mocks.createNodeRecord.mockResolvedValue({ id: 'relay-node' });
    mocks.provisionNode.mockResolvedValue(undefined);
    mocks.markIdle.mockResolvedValue(undefined);
    mocks.verifyCallbackToken.mockResolvedValue({
      workspace: 'relay-node',
      type: 'callback',
      scope: 'node',
    });
  });

  it('accepts a current healthy relay owned by the workspace user', async () => {
    const env = makeEnv((sql, values) => {
      expect(sql).toContain("health_status = 'healthy'");
      expect(sql).toContain("runtime = 'vm'");
      expect(sql).toContain('capacity_pool_id IS NULL');
      expect(values.slice(0, 6)).toEqual([
        'relay-node',
        'user-1',
        'abcdef1234567890',
        'hetzner',
        'nbg1',
        'medium',
      ]);
      return { id: 'relay-node' };
    });

    await expect(
      verifySessionSnapshotRelayAuthorization(
        env,
        'user-1',
        null,
        'relay-node',
        'Bearer relay-token'
      )
    ).resolves.toBeUndefined();
    expect(mocks.verifyCallbackToken).toHaveBeenCalledWith('relay-token', env, {
      expectedScope: 'node',
    });
    expect(mocks.resolveCanonicalVmAllocationPlan).toHaveBeenCalledWith(
      expect.anything(),
      env,
      expect.objectContaining({
        entryPoint: 'session-snapshot-relay',
        userId: 'user-1',
        projectId: null,
        credentialProjectPolicy: 'inherited-or-none',
      })
    );
  });

  it('rejects incomplete, mismatched, and cross-user relay authorization', async () => {
    const env = makeEnv(() => null);

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', null, 'relay-node', undefined)
    ).rejects.toThrow('Invalid snapshot relay authorization');

    mocks.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'other-node',
      type: 'callback',
      scope: 'node',
    });
    await expect(
      verifySessionSnapshotRelayAuthorization(
        env,
        'user-1',
        null,
        'relay-node',
        'Bearer relay-token'
      )
    ).rejects.toThrow('Invalid snapshot relay authorization');

    await expect(
      verifySessionSnapshotRelayAuthorization(
        env,
        'user-1',
        null,
        'relay-node',
        'Bearer relay-token'
      )
    ).rejects.toThrow('Invalid snapshot relay authorization');
  });

  it('leaves non-relay direct-upload authorization unchanged', async () => {
    const env = makeEnv(() => {
      throw new Error('direct upload must not query relay nodes');
    });

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', null, undefined, undefined)
    ).resolves.toBeUndefined();
    expect(mocks.verifyCallbackToken).not.toHaveBeenCalled();
    expect(mocks.resolveCanonicalVmAllocationPlan).not.toHaveBeenCalled();
  });

  it('selects only a healthy current-generation same-user VM relay', async () => {
    const env = makeEnv((sql, values) => {
      expect(sql).toContain('agent_version = ?');
      expect(sql).toContain("runtime = 'vm'");
      expect(sql).toContain('capacity_pool_id IS NULL');
      expect(values.slice(0, 5)).toEqual([
        'user-1',
        'abcdef1234567890',
        'hetzner',
        'nbg1',
        'medium',
      ]);
      return { id: 'relay-node', name: 'current relay' };
    });

    await expect(findSessionSnapshotUploadRelay(env, 'user-1')).resolves.toEqual({
      id: 'relay-node',
      name: 'current relay',
    });
  });

  it('builds a direct VM URL with the authorization path encoded as data', () => {
    const env = makeEnv(() => null);
    const authorizationPath =
      '/api/workspaces/ws-1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=gen-1';
    const relayUrl = new URL(buildSessionSnapshotRelayUploadUrl(env, 'NODE-1', authorizationPath));

    expect(relayUrl.origin).toBe('https://node-1.vm.example.test:8443');
    expect(relayUrl.pathname).toBe('/session-snapshot-upload-relay');
    expect(relayUrl.searchParams.get('authorizationPath')).toBe(authorizationPath);
  });

  it('keeps current agents on direct R2 without looking for a relay', async () => {
    const env = makeEnv(() => {
      throw new Error('current direct upload must not query relay nodes');
    });

    await expect(
      resolveSessionSnapshotUploadTargets(env, {
        workspaceId: 'ws-1',
        userId: 'user-1',
        projectId: null,
        chatSessionId: 'chat-1',
        generation: 'gen-1',
        directUploadAvailable: true,
        directUploadSupported: true,
      })
    ).resolves.toEqual({
      upload: {
        home: '/api/workspaces/ws-1/session-snapshot/artifacts/home?chatSessionId=chat-1&generation=gen-1',
        wip: '/api/workspaces/ws-1/session-snapshot/artifacts/wip?chatSessionId=chat-1&generation=gen-1',
      },
      directUpload: {
        home: '/api/workspaces/ws-1/session-snapshot/artifacts/home/upload-url?chatSessionId=chat-1&generation=gen-1',
        wip: '/api/workspaces/ws-1/session-snapshot/artifacts/wip/upload-url?chatSessionId=chat-1&generation=gen-1',
      },
      needsRelayProvisioning: false,
    });
  });

  it('provisions one rollout replacement, respects quota, and puts it in the normal warm pool', async () => {
    const env = makeEnv((sql) => {
      if (sql.includes('agent_version = ?')) return null;
      if (sql.includes('FROM projects') && sql.includes('default_vm_size'))
        return projectDefaultsRow();
      if (sql.includes('name = ?')) return null;
      if (sql.includes('agent_version, provider_instance_type')) return sourceNode();
      if (sql.includes('SELECT status FROM nodes')) return { status: 'running' };
      if (sql.includes('warm_node_timeout_ms')) return { warm_node_timeout_ms: 7_200_000 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await ensureSessionSnapshotUploadRelay(env, {
      userId: 'user-1',
      sourceNodeId: 'legacy-node',
      projectId: 'project-1',
    });

    expect(mocks.resolveCanonicalVmAllocationPlan).toHaveBeenLastCalledWith(
      expect.anything(),
      env,
      expect.objectContaining({
        entryPoint: 'session-snapshot-relay',
        userId: 'user-1',
        projectId: 'project-1',
        project: projectDefaultsRow(),
        credentialProjectPolicy: 'current-project',
        explicit: expect.objectContaining({
          vmSize: 'medium',
          provider: 'hetzner',
          vmLocation: 'nbg1',
          native: expect.objectContaining({ providerInstanceType: 'cx22' }),
        }),
      })
    );
    expect(mocks.checkQuotaForUser).toHaveBeenCalled();
    expect(mocks.createNodeRecord).toHaveBeenCalledWith(
      env,
      expect.objectContaining({
        userId: 'user-1',
        name: 'Session snapshot relay abcdef123456',
        vmSize: 'medium',
        vmLocation: 'nbg1',
        cloudProvider: 'hetzner',
        credentialAttributionSource: 'platform',
        providerInstanceType: 'cx22',
      })
    );
    expect(mocks.provisionNode).toHaveBeenCalledWith(
      'relay-node',
      env,
      undefined,
      expect.objectContaining({
        authorityProjectId: 'project-1',
        assertExternalMutationAuthority: expect.any(Function),
      })
    );
    const options = mocks.provisionNode.mock.calls[0]![3] as {
      assertExternalMutationAuthority: () => Promise<void>;
    };
    await options.assertExternalMutationAuthority();
    expect(mocks.assertRelayProvisioningAuthority).toHaveBeenCalledWith(env, {
      userId: 'user-1',
      projectId: 'project-1',
      sourceNode: sourceNode(),
      requiredAgentVersion: 'abcdef1234567890',
      relayNodeId: 'relay-node',
      relayName: 'Session snapshot relay abcdef123456',
    });
    expect(mocks.markIdle).toHaveBeenCalledWith('relay-node', 'user-1', 7_200_000);
  });

  it('cleans up a replacement relay when provisioning does not leave it running', async () => {
    const env = makeEnv((sql) => {
      if (sql.includes('agent_version = ?')) return null;
      if (sql.includes('FROM projects') && sql.includes('default_vm_size'))
        return projectDefaultsRow();
      if (sql.includes('name = ?')) return null;
      if (sql.includes('agent_version, provider_instance_type')) return sourceNode();
      if (sql.includes('SELECT status FROM nodes')) return { status: 'error' };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await ensureSessionSnapshotUploadRelay(env, {
      userId: 'user-1',
      sourceNodeId: 'legacy-node',
      projectId: 'project-1',
    });

    expect(mocks.cleanupFreshProvisioningNode).toHaveBeenCalledWith(env, {
      nodeId: 'relay-node',
      userId: 'user-1',
      nodeRole: 'workspace',
      reason: 'session_snapshot_relay_not_running',
    });
    expect(mocks.markIdle).not.toHaveBeenCalled();
  });
});
