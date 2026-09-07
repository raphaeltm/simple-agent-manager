import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteNodeResourcesStrict: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('../../../src/services/strict-node-deletion', () => ({
  deleteNodeResourcesStrict: mocks.deleteNodeResourcesStrict,
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { error: mocks.logError },
  serializeError: vi.fn((err: unknown) => ({
    error: err instanceof Error ? err.message : String(err),
  })),
}));

import type { Env } from '../../../src/env';
import {
  assertDeploymentProvisioningAuthority,
  assertDirectWorkspaceProvisioningAuthority,
  assertRelayProvisioningAuthority,
  assertTrialProvisioningAuthority,
  cleanupFreshProvisioningNode,
  ProvisioningAuthorityError,
} from '../../../src/services/provisioning-authority';
import { deleteNodeResourcesStrict } from '../../../src/services/strict-node-deletion';

type RawMethod = 'first' | 'run';
type RawResolver = (sql: string, binds: unknown[], method: RawMethod) => unknown | Promise<unknown>;

function makeEnv(resolver: RawResolver) {
  const statements: Array<{ method: RawMethod; sql: string; binds: unknown[] }> = [];
  const database = {
    prepare: vi.fn((sql: string) => {
      const statement = {
        binds: [] as unknown[],
        bind: vi.fn((...binds: unknown[]) => {
          statement.binds = binds;
          return statement;
        }),
        first: vi.fn(async () => {
          statements.push({ method: 'first', sql, binds: statement.binds });
          return resolver(sql, statement.binds, 'first');
        }),
        run: vi.fn(async () => {
          statements.push({ method: 'run', sql, binds: statement.binds });
          return resolver(sql, statement.binds, 'run');
        }),
      };
      return statement;
    }),
  } as unknown as D1Database;

  return { env: { DATABASE: database } as unknown as Env, statements };
}

describe('provisioning authority helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteNodeResourcesStrict.mockResolvedValue(undefined);
  });

  it('requires exact active project membership and placeholder state for direct workspace provisioning', async () => {
    const { env, statements } = makeEnv(() => ({ ok: 1 }));

    await assertDirectWorkspaceProvisioningAuthority(env, {
      workspaceId: 'ws-1',
      taskId: 'task-1',
      userId: 'user-1',
      projectId: 'project-1',
      expectedNodeId: null,
      chatSessionId: 'chat-1',
    });

    const statement = statements[0]!;
    expect(statement.sql).toContain('JOIN project_members pm');
    expect(statement.sql).toContain("pm.status = 'active'");
    expect(statement.sql).toContain('pm.removed_at IS NULL');
    expect(statement.sql).toContain('w.node_id IS ?');
    expect(statement.sql).toContain('w.chat_session_id IS ?');
    expect(statement.sql).toContain("w.status = 'creating'");
    expect(statement.sql).toContain("t.status IN ('queued', 'in_progress')");
    expect(statement.binds).toEqual(['task-1', 'ws-1', 'user-1', 'project-1', null, 'chat-1']);
  });

  it('fails closed when direct workspace authority is not current', async () => {
    const { env } = makeEnv(() => null);

    await expect(
      assertDirectWorkspaceProvisioningAuthority(env, {
        workspaceId: 'ws-1',
        taskId: 'task-1',
        userId: 'user-1',
        projectId: 'project-1',
        expectedNodeId: 'node-1',
      })
    ).rejects.toBeInstanceOf(ProvisioningAuthorityError);
  });

  it('requires active deployment environment, member, node role, provider, location, native identity, and mode', async () => {
    const { env, statements } = makeEnv(() => ({ ok: 1 }));

    await assertDeploymentProvisioningAuthority(env, {
      environmentId: 'env-1',
      projectId: 'project-1',
      userId: 'user-1',
      nodeId: 'node-1',
      provider: 'hetzner',
      location: 'fsn1',
      providerInstanceType: 'native-sku',
      providerInstanceBootDiskSizeGb: null,
      providerInstanceImage: null,
      providerInstanceArchitecture: null,
      nodeMode: 'exclusive',
      requiresVolumes: true,
    });

    const statement = statements[0]!;
    expect(statement.sql).toContain('FROM deployment_environments de');
    expect(statement.sql).toContain('JOIN project_members pm');
    expect(statement.sql).toContain("de.status = 'active'");
    expect(statement.sql).toContain("n.status IN ('creating', 'running')");
    expect(statement.sql).toContain("n.node_role = 'deployment'");
    expect(statement.sql).toContain('n.cloud_provider = ?');
    expect(statement.sql).toContain('n.vm_location = ?');
    expect(statement.sql).toContain('n.provider_instance_type = ?');
    expect(statement.binds).toEqual([
      'user-1',
      'user-1',
      'env-1',
      'project-1',
      'node-1',
      'hetzner',
      'fsn1',
      1,
      'exclusive',
      'hetzner',
      'fsn1',
      'native-sku',
      null,
      null,
      null,
    ]);
  });

  it('requires pending unclaimed trial ownership and active sentinel project membership', async () => {
    const { env, statements } = makeEnv(() => ({ ok: 1 }));

    await assertTrialProvisioningAuthority(env, {
      trialId: 'trial-1',
      projectId: 'project-1',
      userId: 'system_anonymous_trials',
      nowMs: 1234,
    });

    const statement = statements[0]!;
    expect(statement.sql).toContain('FROM trials t');
    expect(statement.sql).toContain('JOIN projects p');
    expect(statement.sql).toContain('JOIN project_members pm');
    expect(statement.sql).toContain("t.status = 'pending'");
    expect(statement.sql).toContain('t.claimed_by_user_id IS NULL');
    expect(statement.sql).toContain('t.expires_at > ?');
    expect(statement.binds).toEqual([
      'system_anonymous_trials',
      'system_anonymous_trials',
      'trial-1',
      'project-1',
      1234,
    ]);
  });

  it('requires exact relay source identity, current project membership, and no duplicate relay', async () => {
    const { env, statements } = makeEnv(() => ({ ok: 1 }));

    await assertRelayProvisioningAuthority(env, {
      userId: 'user-1',
      projectId: 'project-1',
      sourceNode: {
        id: 'legacy-node',
        cloud_provider: 'hetzner',
        vm_location: 'nbg1',
        provider_instance_type: 'cx22',
        provider_instance_boot_disk_size_gb: 80,
        provider_instance_image: 'ubuntu-24.04',
        provider_instance_architecture: 'x86',
      },
      requiredAgentVersion: 'required-version',
      relayNodeId: 'relay-node',
      relayName: 'Session snapshot relay required',
    });

    const statement = statements[0]!;
    expect(statement.sql).toContain('JOIN nodes relay');
    expect(statement.sql).toContain("relay.status IN ('creating', 'running')");
    expect(statement.sql).toContain("source.status = 'running'");
    expect(statement.sql).toContain("source.runtime = 'vm'");
    expect(statement.sql).toContain('(source.agent_version IS NULL OR source.agent_version != ?)');
    expect(statement.sql).toContain('source.cloud_provider IS ?');
    expect(statement.sql).toContain('source.provider_instance_type IS ?');
    expect(statement.sql).toContain('source.provider_instance_image IS ?');
    expect(statement.sql).toContain('FROM project_members pm');
    expect(statement.sql).toContain('AND NOT EXISTS');
    expect(statement.sql).toContain("duplicate.status IN ('creating', 'running')");
    expect(statement.sql).toContain(
      'duplicate.provider_instance_type IS relay.provider_instance_type'
    );
    expect(statement.binds).toEqual([
      'relay-node',
      'user-1',
      'Session snapshot relay required',
      'legacy-node',
      'user-1',
      'required-version',
      'hetzner',
      'nbg1',
      'cx22',
      80,
      'ubuntu-24.04',
      'x86',
      'project-1',
      'user-1',
      'user-1',
      'Session snapshot relay required',
      'relay-node',
    ]);
  });

  it('deletes an unattached placeholder node without reaching the provider', async () => {
    const { env, statements } = makeEnv((_sql, _binds, method) => {
      if (method === 'first') return { id: 'node-1', status: 'error', providerInstanceId: null };
      return { meta: { changes: 1 } };
    });

    await expect(
      cleanupFreshProvisioningNode(env, {
        nodeId: 'node-1',
        userId: 'user-1',
        nodeRole: 'workspace',
        reason: 'test-placeholder',
      })
    ).resolves.toBe('placeholder-deleted');

    expect(deleteNodeResourcesStrict).not.toHaveBeenCalled();
    expect(statements[0]!.sql).toContain('NOT EXISTS');
    expect(statements[0]!.sql).toContain('FROM workspaces w');
    expect(statements[0]!.sql).toContain('FROM deployment_environments de');
    expect(statements[1]!.sql).toContain('DELETE FROM nodes');
  });

  it('strictly deletes a provisioned fresh node and reports cleanup failure without hiding it', async () => {
    const { env } = makeEnv(() => ({
      id: 'node-1',
      status: 'running',
      providerInstanceId: 'vm-1',
    }));

    await expect(
      cleanupFreshProvisioningNode(env, {
        nodeId: 'node-1',
        userId: 'user-1',
        nodeRole: 'deployment',
        reason: 'test-strict',
      })
    ).resolves.toBe('strict-deleted');
    expect(deleteNodeResourcesStrict).toHaveBeenCalledWith('node-1', 'user-1', env);

    mocks.deleteNodeResourcesStrict.mockRejectedValueOnce(new Error('provider delete failed'));
    await expect(
      cleanupFreshProvisioningNode(env, {
        nodeId: 'node-1',
        userId: 'user-1',
        nodeRole: 'deployment',
        reason: 'test-failure',
      })
    ).resolves.toBe('failed');
    expect(mocks.logError).toHaveBeenCalledWith(
      'provisioning_authority.fresh_node_cleanup_failed',
      expect.objectContaining({ nodeId: 'node-1', reason: 'test-failure' })
    );
  });
});
