import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveEffectiveDefaultCapacityPoolSummary: vi.fn(),
  resolveCredentialSource: vi.fn(),
}));

vi.mock('../../../src/services/default-capacity-pools', () => ({
  resolveEffectiveDefaultCapacityPoolSummary: mocks.resolveEffectiveDefaultCapacityPoolSummary,
}));

vi.mock('../../../src/services/provider-credentials', () => ({
  resolveCredentialSource: mocks.resolveCredentialSource,
}));

const {
  resolveTaskStartPlacement,
  resolveTaskStartPlacementCredentialAttributionFromPlacement,
} = await import('../../../src/services/placement-resolver');

describe('task-start placement capacity pool failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveCredentialSource.mockResolvedValue({
      credentialSource: 'user',
      providerName: 'hetzner',
    });
  });

  it('fails closed instead of falling back to legacy credentials when pool resolution errors', async () => {
    mocks.resolveEffectiveDefaultCapacityPoolSummary.mockRejectedValueOnce(
      new Error('capacity pool storage unavailable')
    );
    const placement = resolveTaskStartPlacement({
      entryPoint: 'task-submit',
      taskId: 'task-1',
      projectId: 'project-1',
      userId: 'user-1',
      project: {
        id: 'project-1',
        defaultVmSize: 'medium',
        defaultProvider: 'hetzner',
        defaultLocation: 'fsn1',
        defaultWorkspaceProfile: 'full',
        defaultDevcontainerConfigName: null,
        defaultAgentType: 'openai-codex',
      },
      credentialProjectPolicy: 'current-project',
      taskModeDefault: 'task',
      resourceRequirements: {},
    });

    await expect(
      resolveTaskStartPlacementCredentialAttributionFromPlacement({} as never, placement)
    ).rejects.toThrow('capacity pool storage unavailable');
    expect(mocks.resolveCredentialSource).not.toHaveBeenCalled();
  });
});
