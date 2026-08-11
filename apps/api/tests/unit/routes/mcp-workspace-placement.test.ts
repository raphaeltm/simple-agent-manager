import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  fetchNodeAgent: vi.fn(),
  signTerminalToken: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({ drizzle: mocks.drizzle }));
vi.mock('../../../src/services/jwt', () => ({
  signNodeManagementToken: vi.fn(),
  signPortAccessToken: vi.fn(),
  signTerminalToken: mocks.signTerminalToken,
}));
vi.mock('../../../src/services/node-agent', () => ({ fetchNodeAgent: mocks.fetchNodeAgent }));

import {
  enrichWorkspaceInfoWithPlacement,
  handleGetWorkspaceInfo,
} from '../../../src/routes/mcp/workspace-tools';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('get_workspace_info placement enrichment', () => {
  it('adds a concise summary and typed detail without exposing unrelated canaries', () => {
    const canary = 'CANARY_SECRET';
    const raw = JSON.stringify({
      schemaVersion: 2,
      outcome: 'reused',
      selectionPath: 'capacity',
      selectedNodeId: 'node-1',
      summary: 'Reused a compatible node.',
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
      rawAgentVersion: canary,
      providerError: canary,
    });

    const result = enrichWorkspaceInfoWithPlacement({ id: 'workspace-1' }, raw);
    const serialized = JSON.stringify(result);

    expect(result.placement).toMatchObject({ summary: 'Reused a compatible node.' });
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain('rawAgentVersion');
    expect(serialized).not.toContain('providerError');
  });

  it('returns placement null for malformed records', () => {
    expect(enrichWorkspaceInfoWithPlacement('legacy-vm-result', '{bad json')).toEqual({
      workspaceInfo: 'legacy-vm-result',
      placement: null,
    });
  });

  it('reads D1 placement, proxies VM metadata, and returns one enriched MCP result', async () => {
    const placementExplanationJson = JSON.stringify({
      schemaVersion: 2,
      outcome: 'reused',
      selectionPath: 'capacity',
      selectedNodeId: 'node-1',
      summary: 'Reused a compatible node.',
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
    });
    const d1Rows = [
      {
        id: 'workspace-1',
        status: 'running',
        nodeId: 'node-1',
        projectId: 'project-1',
        placementExplanationJson,
      },
    ];
    mocks.drizzle.mockReturnValue({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn(async () => d1Rows) })),
        })),
      })),
    });
    mocks.signTerminalToken.mockResolvedValue({ token: 'terminal-token' });
    mocks.fetchNodeAgent.mockResolvedValue(
      Response.json({ id: 'workspace-1', branch: 'main', vmSize: 'medium' })
    );

    const response = await handleGetWorkspaceInfo(
      'request-1',
      {
        taskId: 'task-1',
        projectId: 'project-1',
        userId: 'user-1',
        workspaceId: 'workspace-1',
        createdAt: '2026-08-11T00:00:00.000Z',
      },
      {
        DATABASE: {},
        BASE_DOMAIN: 'example.invalid',
        VM_AGENT_PROTOCOL: 'https',
        VM_AGENT_PORT: '8443',
      } as never
    );
    const text = (response.result as { content: Array<{ text: string }> }).content[0]?.text;
    const result = JSON.parse(text ?? '{}');

    expect(result).toMatchObject({
      id: 'workspace-1',
      branch: 'main',
      placement: {
        summary: 'Reused a compatible node.',
        detail: { schemaVersion: 2, selectedNodeId: 'node-1' },
      },
    });
    expect(mocks.fetchNodeAgent).toHaveBeenCalledWith(
      'node-1',
      expect.anything(),
      'https://node-1.vm.example.invalid:8443/workspaces/workspace-1/mcp/workspace-info',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer terminal-token' },
      }),
      15_000
    );
  });
});
