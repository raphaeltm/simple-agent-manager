import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useActivityVerifyTimer } from '../../../src/components/project-message-view/useActivityVerifyTimer';
import { getChatSessionState } from '../../../src/lib/api';

vi.mock('../../../src/lib/api', () => ({
  getChatSessionState: vi.fn(),
}));

const getChatSessionStateMock = vi.mocked(getChatSessionState);

describe('useActivityVerifyTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('verifies activity through the lightweight session state endpoint', async () => {
    const currentPlan = [{ content: 'Hydrate through state endpoint', status: 'in_progress' as const }];
    getChatSessionStateMock.mockResolvedValue({
      state: {
        activity: 'idle',
        activityAt: 1000,
        statusError: null,
        currentPlan,
        planUpdatedAt: 1200,
        promptStartedAt: null,
        agentType: null,
        lastStopReason: null,
      },
      agentSessionId: 'acp-1',
      agentType: null,
    });
    const onVerifiedIdle = vi.fn();
    const onStateSnapshot = vi.fn();

    const { result } = renderHook(() => useActivityVerifyTimer({
      projectId: 'proj-1',
      sessionId: 'sess-1',
      delayMs: 1000,
      logMessage: 'verify failed',
      onVerifiedIdle,
      onStateSnapshot,
    }));

    act(() => {
      result.current.startVerifyDecayTimer();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(getChatSessionStateMock).toHaveBeenCalledWith(
      'proj-1',
      'sess-1',
      { signal: expect.any(AbortSignal) },
    );
    expect(onVerifiedIdle).toHaveBeenCalledOnce();
    expect(onStateSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      currentPlan,
      planUpdatedAt: 1200,
    }));
  });
});
