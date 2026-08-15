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
  checkQuotaForUser: vi.fn(),
  createNodeRecord: vi.fn(),
  markIdle: vi.fn(),
  provisionNode: vi.fn(),
  resolveCredentialSource: vi.fn(),
  verifyCallbackToken: vi.fn(),
}));

vi.mock('../../../src/services/compute-quotas', () => ({
  checkQuotaForUser: mocks.checkQuotaForUser,
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
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
    credential_attribution_user_id: 'user-1',
    credential_attribution_project_id: null,
    credential_attribution_source: 'platform',
  };
}

describe('session snapshot upload relay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCredentialSource.mockResolvedValue({
      credentialSource: 'platform',
      providerName: 'hetzner',
    });
    mocks.checkQuotaForUser.mockResolvedValue({ allowed: true });
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
      expect(values).toEqual(['relay-node', 'user-1', 'abcdef1234567890']);
      return { id: 'relay-node' };
    });

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', 'relay-node', 'Bearer relay-token')
    ).resolves.toBeUndefined();
    expect(mocks.verifyCallbackToken).toHaveBeenCalledWith('relay-token', env, {
      expectedScope: 'node',
    });
  });

  it('rejects incomplete, mismatched, and cross-user relay authorization', async () => {
    const env = makeEnv(() => null);

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', 'relay-node', undefined)
    ).rejects.toThrow('Invalid snapshot relay authorization');

    mocks.verifyCallbackToken.mockResolvedValueOnce({
      workspace: 'other-node',
      type: 'callback',
      scope: 'node',
    });
    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', 'relay-node', 'Bearer relay-token')
    ).rejects.toThrow('Invalid snapshot relay authorization');

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', 'relay-node', 'Bearer relay-token')
    ).rejects.toThrow('Invalid snapshot relay authorization');
  });

  it('leaves non-relay direct-upload authorization unchanged', async () => {
    const env = makeEnv(() => {
      throw new Error('direct upload must not query relay nodes');
    });

    await expect(
      verifySessionSnapshotRelayAuthorization(env, 'user-1', undefined, undefined)
    ).resolves.toBeUndefined();
    expect(mocks.verifyCallbackToken).not.toHaveBeenCalled();
  });

  it('selects only a healthy current-generation same-user VM relay', async () => {
    const env = makeEnv((sql, values) => {
      expect(sql).toContain('agent_version = ?');
      expect(values).toEqual(['user-1', 'abcdef1234567890']);
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
      if (sql.includes('name = ?')) return null;
      if (sql.includes('credential_attribution_user_id')) return sourceNode();
      if (sql.includes('SELECT status FROM nodes')) return { status: 'running' };
      if (sql.includes('warm_node_timeout_ms')) return { warm_node_timeout_ms: 7_200_000 };
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await ensureSessionSnapshotUploadRelay(env, {
      userId: 'user-1',
      sourceNodeId: 'legacy-node',
      projectId: 'project-1',
    });

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
      })
    );
    expect(mocks.provisionNode).toHaveBeenCalledWith('relay-node', env);
    expect(mocks.markIdle).toHaveBeenCalledWith('relay-node', 'user-1', 7_200_000);
  });
});
