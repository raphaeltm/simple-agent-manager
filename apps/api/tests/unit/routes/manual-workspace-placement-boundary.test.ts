import { describe, expect, it } from 'vitest';

import { resolveManualWorkspacePlacement } from '../../../src/routes/workspaces/manual-placement';

describe('manual workspace placement boundary', () => {
  it('reuses an eligible real D1 candidate with a finalized typed decision', async () => {
    const requiredVersion = 'a'.repeat(40);
    const nodeId = '01KZR2JAP92AK3SKW951E4H21M';
    const queryResults: unknown[][] = [
      [
        {
          id: nodeId,
          status: 'running',
          runtime: 'vm',
          vmSize: 'medium',
          vmLocation: 'hel1',
          healthStatus: 'healthy',
          lastHeartbeatAt: new Date().toISOString(),
          agentReadyAt: new Date().toISOString(),
          agentVersion: requiredVersion,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 10 }),
          warmSince: null,
        },
      ],
      [],
    ];
    const db = {
      select() {
        const rows = queryResults.shift() ?? [];
        return {
          from() {
            return { where: async () => rows };
          },
        };
      },
    };

    const result = await resolveManualWorkspacePlacement({
      db: db as never,
      env: { VM_AGENT_REQUIRED_VERSION: requiredVersion } as never,
      userId: 'user-1',
      projectId: 'project-1',
      workspaceName: 'Workspace',
      vmSize: 'medium',
      vmLocation: 'hel1',
      preferredNodeId: nodeId,
      activeNodeCount: 1,
      maxNodesPerUser: 5,
      heartbeatStaleAfterSeconds: 180,
      now: '2026-08-11T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      nodeId,
      mustProvisionNode: false,
      explanation: {
        schemaVersion: 2,
        outcome: 'reused',
        selectionPath: 'manual',
        selectedNodeId: nodeId,
        evaluatedNodes: [{ nodeId, path: 'manual', accepted: true, rejectionReasons: [] }],
      },
    });
  });

  it('evaluates a real D1 candidate and persists its tenant-safe typed rejection', async () => {
    const requiredVersion = 'a'.repeat(40);
    const rawAgentVersion = `wrong-CANARY_AGENT_VERSION-${'b'.repeat(40)}`;
    const inserted: Array<Record<string, unknown>> = [];
    const queryResults: unknown[][] = [
      [
        {
          id: '01KZR2JAP92AK3SKW951E4H21M',
          status: 'running',
          runtime: 'vm',
          vmSize: 'medium',
          vmLocation: 'hel1',
          healthStatus: 'healthy',
          lastHeartbeatAt: new Date().toISOString(),
          agentReadyAt: new Date().toISOString(),
          agentVersion: rawAgentVersion,
          lastMetrics: JSON.stringify({ cpuLoadAvg1: 2, memoryPercent: 10 }),
          warmSince: null,
        },
      ],
      [],
    ];
    const db = {
      select() {
        const rows = queryResults.shift() ?? [];
        return {
          from() {
            return { where: async () => rows };
          },
        };
      },
      insert() {
        return {
          async values(value: Record<string, unknown>) {
            inserted.push(value);
          },
        };
      },
    };

    await expect(
      resolveManualWorkspacePlacement({
        db: db as never,
        env: { VM_AGENT_REQUIRED_VERSION: requiredVersion } as never,
        userId: 'user-1',
        projectId: 'project-1',
        workspaceName: 'Workspace',
        vmSize: 'medium',
        vmLocation: 'hel1',
        preferredNodeId: '01KZR2JAP92AK3SKW951E4H21M',
        activeNodeCount: 1,
        maxNodesPerUser: 5,
        heartbeatStaleAfterSeconds: 180,
        now: '2026-08-11T00:00:00.000Z',
      })
    ).rejects.toThrow('Selected node is not eligible');

    const stored = JSON.parse(inserted[0]?.placementExplanationJson as string) as Record<
      string,
      unknown
    >;
    expect(stored).toMatchObject({
      schemaVersion: 2,
      outcome: 'failed',
      selectionPath: 'manual',
      evaluatedNodes: [
        {
          nodeId: 'candidate-1',
          accepted: false,
          rejectionReasons: ['agent-version-mismatch'],
        },
      ],
    });
    expect(JSON.stringify(stored)).not.toContain(rawAgentVersion);
    expect(JSON.stringify(stored)).not.toContain('01KZR2JAP92AK3SKW951E4H21M');
  });
});
