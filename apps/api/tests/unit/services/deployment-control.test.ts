import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import {
  assertAgentDeploymentAllowed,
  buildObservedDeploymentUpdate,
  encodeAllowedDeployProfileIds,
  parseAllowedDeployProfileIds,
  reconcileDeploymentReleaseStatuses,
  toDeploymentAgentPolicy,
  toObservedDeploymentState,
} from '../../../src/services/deployment-control';

function tokenData(overrides: Partial<import('../../../src/services/mcp-token').McpTokenData> = {}) {
  return {
    taskId: 'task-1',
    projectId: 'proj-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    createdAt: '2026-06-18T00:00:00Z',
    ...overrides,
  };
}

function createPolicyDb(opts: {
  envRows?: Array<{
    id: string;
    agentDeployEnabled: boolean;
    agentDeployEnabledBy: string | null;
    agentDeployEnabledAt: string | null;
    agentDeployDisabledAt: string | null;
    allowedDeployProfileIdsJson: string | null;
  }>;
  taskRows?: Array<{ agentProfileHint: string | null }>;
}) {
  return {
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((table: unknown) => ({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockImplementation(() => {
            if (table === schema.deploymentEnvironments) {
              return Promise.resolve(opts.envRows ?? []);
            }
            if (table === schema.tasks) {
              return Promise.resolve(opts.taskRows ?? []);
            }
            return Promise.resolve([]);
          }),
        }),
      })),
    })),
  };
}

function createReleaseDb(latestRows: Array<{ id: string; version: number; status: string }>) {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(latestRows),
          }),
        }),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: vi.fn().mockResolvedValue(undefined),
        };
      }),
    }),
  };
}

describe('deployment-control observed state helpers', () => {
  it('normalizes deployment heartbeat state into bounded DB fields', () => {
    const update = buildObservedDeploymentUpdate({
      appliedSeq: 2.8,
      status: ' APPLIED ',
      errorMessage: 'x'.repeat(5000),
      services: [{ name: 'web', status: 'running', health: 'healthy' }],
      deployStatus: { appHealth: 'healthy' },
      diskTelemetry: { rootDisk: { usedPercent: 42 } },
    }, '2026-06-18T10:00:00Z');

    expect(update.observedAppliedSeq).toBe(2);
    expect(update.observedStatus).toBe('applied');
    expect(update.observedErrorMessage).toHaveLength(4096);
    expect(update.observedServicesJson).toContain('"web"');
    expect(update.observedDeployStatusJson).toContain('appHealth');
    expect(update.observedDiskTelemetryJson).toContain('rootDisk');
    expect(update.observedAt).toBe('2026-06-18T10:00:00Z');
  });

  it('hydrates observed state and agent policy from environment rows', () => {
    const row = {
      observedAppliedSeq: 7,
      observedStatus: 'applied',
      observedErrorMessage: null,
      observedServicesJson: '[{"name":"web"}]',
      observedDeployStatusJson: '{"appHealth":"healthy"}',
      observedDiskTelemetryJson: '{"rootDisk":{"usedPercent":40}}',
      observedAt: '2026-06-18T10:00:00Z',
      agentDeployEnabled: true,
      agentDeployEnabledBy: 'user-1',
      agentDeployEnabledAt: '2026-06-18T10:01:00Z',
      agentDeployDisabledAt: null,
      allowedDeployProfileIdsJson: '["profile-a","profile-a","profile-b"]',
    };

    expect(toObservedDeploymentState(row)).toMatchObject({
      appliedSeq: 7,
      status: 'applied',
      services: [{ name: 'web' }],
      deployStatus: { appHealth: 'healthy' },
    });
    expect(toDeploymentAgentPolicy(row)).toMatchObject({
      agentDeployEnabled: true,
      allowedDeployProfileIds: ['profile-a', 'profile-b'],
    });
  });

  it('encodes allowed profile IDs as unique trimmed JSON', () => {
    const encoded = encodeAllowedDeployProfileIds([' profile-a ', 'profile-a', 'profile-b']);
    expect(encoded).toBe('["profile-a","profile-b"]');
    expect(parseAllowedDeployProfileIds(encoded)).toEqual(['profile-a', 'profile-b']);
  });
});

describe('assertAgentDeploymentAllowed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('denies when the environment is missing or inactive', async () => {
    const db = createPolicyDb({ envRows: [] });
    const result = await assertAgentDeploymentAllowed(db as any, 'proj-1', 'staging', tokenData());
    expect(result).toEqual({
      error: "Deployment environment 'staging' not found or inactive for this project.",
    });
  });

  it('denies by default until the user enables agent deployment', async () => {
    const db = createPolicyDb({
      envRows: [{
        id: 'env-1',
        agentDeployEnabled: false,
        agentDeployEnabledBy: null,
        agentDeployEnabledAt: null,
        agentDeployDisabledAt: null,
        allowedDeployProfileIdsJson: null,
      }],
    });

    const result = await assertAgentDeploymentAllowed(db as any, 'proj-1', 'staging', tokenData());
    expect('error' in result ? result.error : '').toContain('Agent deployment is disabled');
  });

  it('allows when enabled and no profile restriction is configured', async () => {
    const db = createPolicyDb({
      envRows: [{
        id: 'env-1',
        agentDeployEnabled: true,
        agentDeployEnabledBy: 'user-1',
        agentDeployEnabledAt: '2026-06-18T10:01:00Z',
        agentDeployDisabledAt: null,
        allowedDeployProfileIdsJson: null,
      }],
    });

    const result = await assertAgentDeploymentAllowed(db as any, 'proj-1', 'staging', tokenData());
    expect(result).toMatchObject({ environmentId: 'env-1' });
  });

  it('enforces allowed agent profile IDs when configured', async () => {
    const db = createPolicyDb({
      envRows: [{
        id: 'env-1',
        agentDeployEnabled: true,
        agentDeployEnabledBy: 'user-1',
        agentDeployEnabledAt: '2026-06-18T10:01:00Z',
        agentDeployDisabledAt: null,
        allowedDeployProfileIdsJson: '["profile-allowed"]',
      }],
      taskRows: [{ agentProfileHint: 'profile-other' }],
    });

    const result = await assertAgentDeploymentAllowed(db as any, 'proj-1', 'staging', tokenData());
    expect('error' in result ? result.error : '').toContain('not allowed to deploy');
  });
});

describe('reconcileDeploymentReleaseStatuses', () => {
  it('marks the latest pending release as applying while the node applies it', async () => {
    const db = createReleaseDb([{ id: 'rel-3', version: 3, status: 'created' }]);

    await reconcileDeploymentReleaseStatuses(db as any, 'env-1', {
      appliedSeq: 2,
      status: 'applying',
    });

    expect(db.updates).toEqual([{ status: 'applying' }]);
  });

  it('marks applied release applied and newer failed release failed after revert', async () => {
    const db = createReleaseDb([{ id: 'rel-3', version: 3, status: 'applying' }]);

    await reconcileDeploymentReleaseStatuses(db as any, 'env-1', {
      appliedSeq: 2,
      status: 'reverted',
    });

    expect(db.updates).toEqual([{ status: 'applied' }, { status: 'failed' }]);
  });
});
