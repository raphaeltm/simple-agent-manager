import { describe, expect, it } from 'vitest';

import { enrichWorkspaceInfoWithPlacement } from '../../../src/routes/mcp/workspace-tools';

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
});
