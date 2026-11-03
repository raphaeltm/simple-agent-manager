import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  cancelAgentSessionOnNode: vi.fn(),
  getSessionState: vi.fn(),
  recordSessionTurnEnd: vi.fn(),
}));

vi.mock('../../../src/services/node-agent', () => ({
  cancelAgentSessionOnNode: (...args: unknown[]) => mocks.cancelAgentSessionOnNode(...args),
}));
vi.mock('../../../src/services/project-data', () => ({
  getSessionState: (...args: unknown[]) => mocks.getSessionState(...args),
  recordSessionTurnEnd: (...args: unknown[]) => mocks.recordSessionTurnEnd(...args),
}));

const { endAgentTurnForRequiredSleep } =
  await import('../../../src/services/session-sleep-required-turn-end');

const env = {} as never;
const workspace = {
  id: 'workspace-1',
  userId: 'user-1',
  projectId: 'project-1',
  nodeId: 'node-1',
  nodeRuntime: 'vm',
  nodeStatus: 'running',
};

describe('endAgentTurnForRequiredSleep', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSessionState.mockResolvedValue({ activity: 'prompting' });
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: true, status: 200 });
    mocks.recordSessionTurnEnd.mockResolvedValue(true);
  });

  it('cancels the turn on the agent (kill and idle restart) and records the turn end', async () => {
    await expect(
      endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' })
    ).resolves.toBe(true);
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-1',
      env,
      'user-1',
      { requestTimeoutMs: undefined }
    );
    expect(mocks.recordSessionTurnEnd).toHaveBeenCalledWith(env, 'project-1', 'agent-1', {
      reason: 'cancelled',
      observedAt: expect.any(Number),
    });
  });

  it('passes a control-loop timeout through to the agent call', async () => {
    await endAgentTurnForRequiredSleep(env, workspace, 'agent-1', {
      reason: 'test',
      requestTimeoutMs: 5000,
    });
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledWith(
      'node-1',
      'workspace-1',
      'agent-1',
      env,
      'user-1',
      { requestTimeoutMs: 5000 }
    );
  });

  it('also ends a turn that is recovering', async () => {
    mocks.getSessionState.mockResolvedValue({ activity: 'recovering' });
    await endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' });
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledTimes(1);
  });

  it.each(['idle', 'error', 'stopped'])(
    'does nothing when the activity is %s',
    async (activity) => {
      mocks.getSessionState.mockResolvedValue({ activity });
      await expect(
        endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' })
      ).resolves.toBe(false);
      expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
      expect(mocks.recordSessionTurnEnd).not.toHaveBeenCalled();
    }
  );

  it('never calls a sleeping Instant container, which a cancel would wake', async () => {
    await endAgentTurnForRequiredSleep(
      env,
      { ...workspace, nodeRuntime: 'cf-container', nodeStatus: 'sleeping' },
      'agent-1',
      { reason: 'test' }
    );
    expect(mocks.cancelAgentSessionOnNode).not.toHaveBeenCalled();
    // Like the agent's 409: nothing is in flight, so the stale turn is ended.
    expect(mocks.recordSessionTurnEnd).toHaveBeenCalledTimes(1);
  });

  it('cancels on a running Instant container like a VM (rule 61)', async () => {
    await endAgentTurnForRequiredSleep(
      env,
      { ...workspace, nodeRuntime: 'cf-container', nodeStatus: 'running' },
      'agent-1',
      { reason: 'test' }
    );
    expect(mocks.cancelAgentSessionOnNode).toHaveBeenCalledTimes(1);
  });

  it.each([404, 409])(
    'ends a stale turn when the agent reports none in flight (%s)',
    async (status) => {
      mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status });
      await expect(
        endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' })
      ).resolves.toBe(true);
      expect(mocks.recordSessionTurnEnd).toHaveBeenCalledTimes(1);
    }
  );

  it('throws when the agent cannot confirm, and records nothing', async () => {
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 502 });
    await expect(
      endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' })
    ).rejects.toThrow('Required sleep could not stop the agent turn (agent responded 502)');
    expect(mocks.recordSessionTurnEnd).not.toHaveBeenCalled();
  });

  it('throws on a timeout or network failure, which the cancel reports as 500', async () => {
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 500 });
    await expect(
      endAgentTurnForRequiredSleep(env, workspace, 'agent-1', { reason: 'test' })
    ).rejects.toThrow('agent responded 500');
    expect(mocks.recordSessionTurnEnd).not.toHaveBeenCalled();
  });

  it('records the turn end without the agent when told to', async () => {
    mocks.cancelAgentSessionOnNode.mockResolvedValue({ success: false, status: 500 });
    await expect(
      endAgentTurnForRequiredSleep(env, workspace, 'agent-1', {
        reason: 'test',
        confirmWithoutAgent: true,
      })
    ).resolves.toBe(true);
    expect(mocks.recordSessionTurnEnd).toHaveBeenCalledTimes(1);
  });
});
