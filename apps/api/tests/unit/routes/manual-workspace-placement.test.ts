import type { PlacementExplanation } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createNodeRecord: vi.fn(),
  drizzle: vi.fn(),
  provisionNode: vi.fn(),
  resolveCredentialSource: vi.fn(),
  scheduleWorkspaceCreateOnNode: vi.fn(),
  selectNodeWithExplanation: vi.fn(),
  waitForNodeAgentReady: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/services/node-agent', () => ({
  waitForNodeAgentReady: mocks.waitForNodeAgentReady,
}));
vi.mock('../../../src/services/node-selector', () => ({
  selectNodeWithExplanation: mocks.selectNodeWithExplanation,
}));
vi.mock('../../../src/services/nodes', () => ({
  createNodeRecord: mocks.createNodeRecord,
  provisionNode: mocks.provisionNode,
}));
vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));
vi.mock('../../../src/routes/workspaces/_helpers', () => ({
  scheduleWorkspaceCreateOnNode: mocks.scheduleWorkspaceCreateOnNode,
}));

import {
  completeManualWorkspacePlacement,
  resolveManualWorkspacePlacement,
} from '../../../src/routes/workspaces/manual-placement';

function placement(outcome: PlacementExplanation['outcome'] = 'failed'): PlacementExplanation {
  return {
    schemaVersion: 2,
    outcome,
    selectionPath: 'manual',
    selectedNodeId: null,
    summary: 'Selected node was rejected.',
    request: {
      runtime: 'vm',
      vmSize: 'medium',
      vmLocation: 'hel1',
      maxWorkspacesPerNode: 5,
      cpuThresholdPercent: 50,
      memoryThresholdPercent: 50,
      heartbeatStaleSeconds: 180,
    },
    evaluatedNodes: [],
    provisioningAttempts: [],
    decidedAt: '2026-08-11T00:00:00.000Z',
    updatedAt: '2026-08-11T00:00:00.000Z',
  };
}

function resolveInput(db: unknown) {
  return {
    db,
    env: {},
    userId: 'user-1',
    projectId: 'project-1',
    workspaceName: 'Workspace',
    vmSize: 'medium' as const,
    vmLocation: 'hel1',
    activeNodeCount: 0,
    maxNodesPerUser: 5,
    heartbeatStaleAfterSeconds: 180,
    now: '2026-08-11T00:00:00.000Z',
  };
}

function insertDb() {
  const inserted: Array<Record<string, unknown>> = [];
  return {
    inserted,
    db: {
      insert() {
        return {
          async values(value: Record<string, unknown>) {
            inserted.push(value);
          },
        };
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('manual workspace placement persistence', () => {
  it('persists a typed failed task when a selected node is rejected', async () => {
    const harness = insertDb();
    mocks.selectNodeWithExplanation.mockResolvedValue({ node: null, explanation: placement() });

    await expect(
      resolveManualWorkspacePlacement({
        ...resolveInput(harness.db),
        preferredNodeId: 'node-rejected',
      } as never)
    ).rejects.toThrow('Selected node is not eligible');

    const stored = harness.inserted[0];
    expect(stored).toMatchObject({ status: 'failed', projectId: 'project-1' });
    expect(JSON.parse(stored?.placementExplanationJson as string)).toMatchObject({
      schemaVersion: 2,
      outcome: 'failed',
    });
  });

  it.each([
    ['node-limit', { activeNodeCount: 5 }],
    ['credentials-unavailable', {}],
  ] as const)('persists %s when provisioning cannot start', async (reason, override) => {
    const harness = insertDb();
    mocks.resolveCredentialSource.mockResolvedValue(null);

    await expect(
      resolveManualWorkspacePlacement({
        ...resolveInput(harness.db),
        ...override,
      } as never)
    ).rejects.toThrow();

    const explanation = JSON.parse(
      harness.inserted[0]?.placementExplanationJson as string
    ) as PlacementExplanation;
    expect(explanation.outcome).toBe('failed');
    expect(explanation.provisioningAttempts).toEqual([
      expect.objectContaining({ outcome: 'failed', failureReason: reason }),
    ]);
  });

  it('updates both workspace and task when asynchronous provisioning fails', async () => {
    const updates: Array<Record<string, unknown>> = [];
    const db = {
      update() {
        return {
          set(value: Record<string, unknown>) {
            updates.push(value);
            return { async where() {} };
          },
        };
      },
      select() {
        return { from: () => ({ where: () => ({ limit: async () => [] }) }) };
      },
    };
    mocks.drizzle.mockReturnValue(db);
    mocks.provisionNode.mockRejectedValue(new Error('CANARY_PROVIDER_DETAIL'));

    await completeManualWorkspacePlacement({
      env: { DATABASE: {} },
      explanation: placement('provisioned'),
      mustProvisionNode: true,
      nodeId: 'node-new',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      userId: 'user-1',
      repository: 'owner/repo',
      branch: 'main',
      project: { id: 'project-1' },
      vmSize: 'medium',
      vmLocation: 'hel1',
    } as never);

    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placementExplanationJson: expect.any(String) }),
        expect.objectContaining({ status: 'error', errorMessage: 'Node provisioning failed' }),
        expect.objectContaining({ status: 'failed', errorMessage: 'Node provisioning failed' }),
      ])
    );
    expect(JSON.stringify(updates)).not.toContain('CANARY_PROVIDER_DETAIL');
    expect(mocks.scheduleWorkspaceCreateOnNode).not.toHaveBeenCalled();
  });

  it('finalizes a reused decision in both workspace and task before scheduling', async () => {
    const updates: Array<Record<string, unknown>> = [];
    mocks.drizzle.mockReturnValue({
      update() {
        return {
          set(value: Record<string, unknown>) {
            updates.push(value);
            return { async where() {} };
          },
        };
      },
    });
    const explanation = placement('reused');
    explanation.selectedNodeId = 'node-existing';

    await completeManualWorkspacePlacement({
      env: { DATABASE: {} },
      explanation,
      mustProvisionNode: false,
      nodeId: 'node-existing',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      userId: 'user-1',
      repository: 'owner/repo',
      branch: 'main',
      project: { id: 'project-1' },
      vmSize: 'medium',
      vmLocation: 'hel1',
    } as never);

    const persisted = updates.filter((update) => 'placementExplanationJson' in update);
    expect(persisted).toHaveLength(2);
    expect(
      persisted.map((update) => JSON.parse(update.placementExplanationJson as string))
    ).toEqual([
      expect.objectContaining({ outcome: 'reused', selectedNodeId: 'node-existing' }),
      expect.objectContaining({ outcome: 'reused', selectedNodeId: 'node-existing' }),
    ]);
    expect(mocks.scheduleWorkspaceCreateOnNode).toHaveBeenCalledOnce();
  });

  it('persists started then succeeded provisioning in both records before scheduling', async () => {
    const updates: Array<Record<string, unknown>> = [];
    mocks.drizzle.mockReturnValue({
      update() {
        return {
          set(value: Record<string, unknown>) {
            updates.push(value);
            return { async where() {} };
          },
        };
      },
      select() {
        return {
          from: () => ({
            where: () => ({
              limit: async () => [{ status: 'running', errorMessage: null }],
            }),
          }),
        };
      },
    });
    mocks.provisionNode.mockResolvedValue(undefined);
    mocks.waitForNodeAgentReady.mockResolvedValue(undefined);
    const explanation = placement('provisioned');
    explanation.selectionPath = 'provisioning';
    explanation.provisioningAttempts = [
      { vmSize: 'medium', vmLocation: 'hel1', outcome: 'started' },
    ];

    await completeManualWorkspacePlacement({
      env: { DATABASE: {} },
      explanation,
      mustProvisionNode: true,
      nodeId: 'node-new',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      userId: 'user-1',
      repository: 'owner/repo',
      branch: 'main',
      project: { id: 'project-1' },
      vmSize: 'medium',
      vmLocation: 'hel1',
    } as never);

    const persisted = updates.filter((update) => 'placementExplanationJson' in update);
    expect(persisted).toHaveLength(2);
    for (const update of persisted) {
      expect(JSON.parse(update.placementExplanationJson as string)).toMatchObject({
        outcome: 'provisioned',
        selectedNodeId: 'node-new',
        provisioningAttempts: [{ outcome: 'started' }, { outcome: 'succeeded' }],
      });
    }
    expect(mocks.provisionNode).toHaveBeenCalledWith('node-new', expect.anything());
    expect(mocks.waitForNodeAgentReady).toHaveBeenCalledWith('node-new', expect.anything());
    expect(mocks.scheduleWorkspaceCreateOnNode).toHaveBeenCalledOnce();
  });
});
