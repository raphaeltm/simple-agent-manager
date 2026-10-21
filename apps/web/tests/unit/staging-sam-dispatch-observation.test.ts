import { describe, expect, it, vi } from 'vitest';

import type { Json } from '../playwright/staging-sam-dispatch-evidence';
import { observeDispatchSession } from '../playwright/staging-sam-dispatch-observation';

describe('one-VM observation failure evidence', () => {
  it('records an unexpected replacement node before failing, without adopting it for deletion', async () => {
    const now = Date.now();
    const ledger: Json = {
      taskId: 'task',
      sessionId: 'session',
      profileId: 'profile',
      workspaceId: 'workspace',
      nodeId: 'original-node',
      dispatchAcceptedAt: now,
      cleanup: {},
      checks: {},
    };
    const saved: Json[] = [];
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        projectId: 'project',
        taskMode: 'conversation',
        agentProfileHint: 'profile',
        outputPrUrl: null,
        workspaceId: 'workspace',
      })
      .mockResolvedValueOnce({ nodeId: 'replacement-node' });
    await expect(
      observeDispatchSession({
        ledger,
        deadline: now + 1_500_000,
        startedAt: now,
        profileName: 'temporary-profile',
        projectId: 'project',
        projectApi: 'https://api.test/project',
        repository: 'owner/repo',
        stagingApi: 'https://api.test',
        baselineWorkspaces: new Set(),
        reportFixture: 'fixture',
        privateCanary: 'canary',
        stopOnly: false,
        check: (condition, label) => {
          if (!condition) throw new Error(label);
        },
        save: async () => {
          saved.push(structuredClone(ledger));
        },
        get,
        wait: vi.fn(),
        observeProvisioning: vi.fn(),
      })
    ).rejects.toThrow('never replaces its allocated node');
    expect(saved.at(-1)?.unexpectedAllocation).toEqual({
      workspaceId: 'workspace',
      previousNodeId: 'original-node',
      observedNodeId: 'replacement-node',
      requiresManualReconciliation: true,
    });
    expect(ledger.nodeId).toBe('original-node');
    expect(ledger.cleanup.unexpectedAllocation).toContain('unconfirmed');
    expect(get).toHaveBeenCalledTimes(2);
  });
});
