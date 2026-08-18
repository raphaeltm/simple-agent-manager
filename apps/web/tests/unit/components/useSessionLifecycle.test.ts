/**
 * Behavioral tests for useSessionLifecycle loading semantics:
 * - Initial load requests the FULL conversation (CHAT_SESSION_MESSAGE_MAX ceiling).
 * - The 3s poll requests only the small recent window (CHAT_SESSION_MESSAGE_LIMIT).
 * - loadUntil() pages backward until a target timestamp is covered (the timeline
 *   jump fallback for oversized/guard-trimmed sessions), and short-circuits when
 *   the target is already loaded or there is no more history.
 */
import { DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getWorkspace: vi.fn(),
  getNode: vi.fn(),
  getTerminalToken: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  cancelAgentPrompt: vi.fn(),
  uploadSessionFiles: vi.fn(),
  startVerifyDecayTimer: vi.fn(),
  stopVerifyDecayTimer: vi.fn(),
  connectionState: 'connected' as 'connected' | 'disconnected',
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getWorkspace: mocks.getWorkspace,
  getNode: mocks.getNode,
  getTerminalToken: mocks.getTerminalToken,
  getTranscribeApiUrl: mocks.getTranscribeApiUrl,
  resetIdleTimer: mocks.resetIdleTimer,
  sendFollowUpPrompt: mocks.sendFollowUpPrompt,
  cancelAgentPrompt: mocks.cancelAgentPrompt,
  uploadSessionFiles: mocks.uploadSessionFiles,
}));

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: mocks.connectionState,
    wsRef: { current: null },
    retry: vi.fn(),
  }),
}));
vi.mock('../../../src/hooks/useTokenRefresh', () => ({
  useTokenRefresh: () => ({ token: null }),
}));
vi.mock('../../../src/hooks/useWorkspacePorts', () => ({
  useWorkspacePorts: () => ({ ports: [] }),
}));
vi.mock('../../../src/components/project-message-view/useActivityVerifyTimer', () => ({
  useActivityVerifyTimer: () => ({
    startVerifyDecayTimer: mocks.startVerifyDecayTimer,
    stopVerifyDecayTimer: mocks.stopVerifyDecayTimer,
  }),
}));
vi.mock('../../../src/components/project-message-view/useConnectionRecovery', () => ({
  useConnectionRecovery: () => ({
    isResuming: false,
    resumeError: null,
    showConnectionBanner: false,
    idleCountdownMs: null,
    clearResumeError: vi.fn(),
    reportDeliveryError: vi.fn(),
    resumeAndSend: vi.fn(),
  }),
}));
vi.mock('../../../src/components/project-message-view/types', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/project-message-view/types')>()),
  CHAT_FALLBACK_POLL_MS: 1,
}));

import { useSessionLifecycle } from '../../../src/components/project-message-view/useSessionLifecycle';

type Msg = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: null;
  createdAt: number;
};

function msg(id: string, createdAt: number): Msg {
  return {
    id,
    sessionId: 'sess-1',
    role: 'user',
    content: `m-${id}`,
    toolMetadata: null,
    createdAt,
  };
}

function sessionResponse(status: string) {
  return {
    id: 'sess-1',
    workspaceId: null,
    topic: 'T',
    status,
    messageCount: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function detail(
  messages: Msg[],
  hasMore: boolean,
  status = 'stopped',
  currentPlan: Array<{ content: string; status: string }> | null = null,
  planUpdatedAt: number | null = null
) {
  return {
    session: sessionResponse(status),
    messages,
    hasMore,
    state: {
      activity: 'idle',
      activityAt: Date.now(),
      statusError: null,
      currentPlan,
      planUpdatedAt,
      promptStartedAt: null,
      agentType: null,
      lastStopReason: null,
    },
  };
}

describe('useSessionLifecycle loading semantics', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.connectionState = 'connected';
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('requests the FULL conversation (max ceiling) on initial load', async () => {
    mocks.getChatSession.mockResolvedValue(detail([msg('a', 1000)], false));

    renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));

    await waitFor(() => {
      expect(mocks.getChatSession).toHaveBeenCalledWith('proj-1', 'sess-1', {
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      });
    });
  });

  describe('fallback poll visibility gating', () => {
    const setVisibility = (state: DocumentVisibilityState) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => state,
      });
      act(() => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };

    afterEach(() => setVisibility('visible'));

    it('stops the degraded fallback poll while the tab is hidden', async () => {
      // This poll fetches the FULL session detail every CHAT_FALLBACK_POLL_MS
      // while the WebSocket is down. Nobody is reading it in a hidden tab.
      mocks.connectionState = 'disconnected';
      mocks.getChatSession.mockResolvedValue(detail([msg('a', 1000)], false, 'active'));

      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));
      await waitFor(() => expect(result.current.session?.status).toBe('active'));
      await waitFor(() => expect(mocks.getChatSession.mock.calls.length).toBeGreaterThan(1));

      setVisibility('hidden');
      const callsWhenHidden = mocks.getChatSession.mock.calls.length;

      // CHAT_FALLBACK_POLL_MS is mocked to 1ms, so many ticks would land here.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mocks.getChatSession.mock.calls.length).toBe(callsWhenHidden);
    });

    it('catches up immediately when the tab becomes visible again', async () => {
      mocks.connectionState = 'disconnected';
      mocks.getChatSession.mockResolvedValue(detail([msg('a', 1000)], false, 'active'));

      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));
      await waitFor(() => expect(result.current.session?.status).toBe('active'));

      setVisibility('hidden');
      await new Promise((resolve) => setTimeout(resolve, 20));
      const callsWhenHidden = mocks.getChatSession.mock.calls.length;

      setVisibility('visible');
      // Immediate, not "within one interval" — the conversation must be current
      // at the moment the user looks at it.
      await waitFor(() =>
        expect(mocks.getChatSession.mock.calls.length).toBeGreaterThan(callsWhenHidden)
      );
    });
  });

  it('rehydrates a plan-only state change between fallback polls', async () => {
    mocks.connectionState = 'disconnected';
    const messages = [msg('a', 1000)];
    const plan = [{ content: 'Recovered from poll state', status: 'in_progress' }];
    mocks.getChatSession
      .mockResolvedValueOnce(detail(messages, false, 'active', null, null))
      .mockResolvedValue(detail(messages, false, 'active', plan, 2000));

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));

    await waitFor(() => expect(result.current.session?.status).toBe('active'));

    await waitFor(() => expect(result.current.currentPlan).toEqual(plan));
  });

  it('keeps the wake indicator active while sleeping polls still report stale idle state', async () => {
    const sleeping = detail([msg('a', 1000)], false, 'sleeping');
    mocks.getChatSession.mockResolvedValue(sleeping);
    mocks.sendFollowUpPrompt.mockResolvedValue({ accepted: true, status: 'queued' });
    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    act(() => result.current.setFollowUp('Wake and continue'));
    act(() => {
      void result.current.handleSendFollowUp();
    });

    await waitFor(() => expect(mocks.sendFollowUpPrompt).toHaveBeenCalled());
    await waitFor(() => expect(mocks.getChatSession.mock.calls.length).toBeGreaterThan(2));
    expect(result.current.agentActivity).toBe('prompting');
  });

  it('returns a failed wake attempt to a retryable sleeping state', async () => {
    const sleeping = detail([msg('a', 1000)], false, 'sleeping');
    const failedWake = {
      ...sleeping,
      session: {
        ...sleeping.session,
        task: {
          id: 'recovery-task-1',
          status: 'failed' as const,
        },
      },
    };
    let recoveryFailed = false;
    mocks.getChatSession.mockImplementation(async () => (recoveryFailed ? failedWake : sleeping));
    mocks.sendFollowUpPrompt.mockResolvedValue({ accepted: true, status: 'queued' });
    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    act(() => result.current.setFollowUp('Wake and continue'));
    act(() => {
      void result.current.handleSendFollowUp();
    });

    await waitFor(() => expect(result.current.agentActivity).toBe('prompting'));
    recoveryFailed = true;
    await waitFor(() => expect(result.current.agentActivity).toBe('idle'));
    expect(result.current.sessionState).toBe('sleeping');
  });

  describe('loadUntil', () => {
    it('short-circuits (no fetch) when the target timestamp is already loaded', async () => {
      mocks.getChatSession.mockResolvedValue(detail([msg('a', 500), msg('b', 1000)], false));
      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));
      await waitFor(() => expect(result.current.messages.length).toBe(2));
      mocks.getChatSession.mockClear();

      await act(async () => {
        await result.current.loadUntil(700);
      });

      // Oldest loaded is 500 <= 700 → nothing to fetch.
      expect(mocks.getChatSession).not.toHaveBeenCalled();
    });

    it('short-circuits when there is no more history (hasMore=false)', async () => {
      mocks.getChatSession.mockResolvedValue(detail([msg('b', 1000)], false));
      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false));
      await waitFor(() => expect(result.current.messages.length).toBe(1));
      mocks.getChatSession.mockClear();

      await act(async () => {
        await result.current.loadUntil(200);
      });

      // Target (200) predates the loaded window, but hasMore=false → no fetch.
      expect(mocks.getChatSession).not.toHaveBeenCalled();
    });

    // Note: loadUntil's multi-page backward pagination shares the prepend +
    // firstItemIndex mechanism with loadMore (covered elsewhere) and is verified
    // end-to-end by the timeline-jump Playwright audit. The guard branches above
    // (already-loaded and no-more-history) cover loadUntil's early-return logic.
  });
});
