import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listAcpSessions: vi.fn(),
  getSessionState: vi.fn(),
  getLatestPersistedPlan: vi.fn(),
}));

vi.mock('../../src/services/project-data', () => mocks);

import { resolveChatAgentState } from '../../src/routes/chat-agent-state';

describe('resolveChatAgentState', () => {
  it('hydrates plan from durable chat messages when the ACP state mirror has no plan', async () => {
    const currentPlan = [{ content: 'Restore from durable plan row', status: 'in_progress' }];
    mocks.listAcpSessions.mockResolvedValue({
      sessions: [{ id: 'acp-1', agentType: 'openai-codex' }],
    });
    mocks.getSessionState.mockResolvedValueOnce({
      activity: 'prompting',
      activityAt: 100,
      statusError: null,
      currentPlan: null,
      planUpdatedAt: null,
      promptStartedAt: 90,
      agentType: 'openai-codex',
      lastStopReason: null,
    });
    mocks.getSessionState.mockResolvedValueOnce(null);
    mocks.getLatestPersistedPlan.mockResolvedValue({
      currentPlan,
      planUpdatedAt: 1234,
    });

    const result = await resolveChatAgentState({} as never, {
      projectId: 'proj-1',
      sessionId: 'chat-1',
      lookupFailureEvent: 'lookup.failed',
      stateFailureEvent: 'state.failed',
    });

    expect(result.state?.activity).toBe('prompting');
    expect(result.state?.currentPlan).toEqual(currentPlan);
    expect(result.state?.planUpdatedAt).toBe(1234);
    expect(mocks.getLatestPersistedPlan).toHaveBeenCalledWith({}, 'proj-1', 'chat-1');
  });
});
