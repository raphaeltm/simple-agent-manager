/**
 * Behavioral tests for useSessionLifecycle loading semantics:
 * - Initial load requests the FULL conversation (CHAT_SESSION_MESSAGE_MAX ceiling).
 * - The 3s poll requests only the small recent window (CHAT_SESSION_MESSAGE_LIMIT).
 * - loadUntil() pages backward until a target timestamp is covered (the timeline
 *   jump fallback for oversized/guard-trimmed sessions), and short-circuits when
 *   the target is already loaded or there is no more history.
 */
import { DEFAULT_CHAT_SESSION_MESSAGE_MAX } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
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
  wsOptions: [] as Array<{ enabled: boolean }>,
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
  useChatWebSocket: (options: { enabled: boolean }) => {
    // Capture the options so tests can assert on `enabled`. The socket gate is
    // production behavior worth pinning: it decides whether wake-progress
    // broadcasts can reach the client at all.
    mocks.wsOptions.push(options);
    return {
      connectionState: mocks.connectionState,
      wsRef: { current: null },
      retry: vi.fn(),
    };
  },
}));
vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({ user: { id: 'user-1' } }),
}));
vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
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
import { chatQueryKeys } from '../../../src/lib/query-options';

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
  let queryClient: QueryClient;
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }

  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.connectionState = 'connected';
    mocks.wsOptions.length = 0;
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('opens the socket while a sleeping session is waking', async () => {
    // Discriminating. A waking session is `sleeping` server-side for the WHOLE
    // wake — wakeSession() only flips it to `active` at the very end. Gating the
    // socket on `active` alone means the client holds no connection during
    // exactly the window the wake-progress broadcasts are sent, so every phase
    // delta is dropped and the push half of the feature is inert.
    const waking = detail([msg('a', 1000)], false, 'sleeping');
    waking.state = { ...waking.state, recoveryStatus: 'waking', wakePhase: 'node_provisioning' };
    mocks.getChatSession.mockResolvedValue(waking);

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.isWaking).toBe(true));
    await waitFor(() => expect(mocks.wsOptions.at(-1)?.enabled).toBe(true));
    expect(result.current.wakePhase).toBe('node_provisioning');
  });

  it('does NOT open the socket for an ordinary sleeping session', async () => {
    // Control for the case above: without this, "enabled: true" could simply mean
    // the gate was removed, which would connect a socket for every sleeping
    // session the user browses past.
    mocks.getChatSession.mockResolvedValue(detail([msg('a', 1000)], false, 'sleeping'));

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.session?.status).toBe('sleeping'));
    expect(result.current.isWaking).toBe(false);
    expect(mocks.wsOptions.every((o) => o.enabled === false)).toBe(true);
  });

  it('requests the FULL conversation (max ceiling) on initial load', async () => {
    mocks.getChatSession.mockResolvedValue(detail([msg('a', 1000)], false));

    renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), { wrapper });

    await waitFor(() => {
      expect(mocks.getChatSession).toHaveBeenCalledWith('proj-1', 'sess-1', {
        signal: expect.any(AbortSignal),
        limit: DEFAULT_CHAT_SESSION_MESSAGE_MAX,
      });
    });
  });

  it('delta-fetches after the newest cached message and merges cached plus new rows', async () => {
    const queryKey = chatQueryKeys.sessionMessages('user-1', 'proj-1', 'sess-1');
    queryClient.setQueryData(queryKey, detail([msg('cached', 1000)], false));
    mocks.getChatSession.mockResolvedValue(detail([msg('new', 2000)], false));

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual(['cached', 'new'])
    );
    expect(mocks.getChatSession).toHaveBeenCalledWith('proj-1', 'sess-1', {
      signal: expect.any(AbortSignal),
      after: 1000,
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

      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
        wrapper,
      });
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

      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
        wrapper,
      });
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

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.session?.status).toBe('active'));

    await waitFor(() => expect(result.current.currentPlan).toEqual(plan));
  });

  it('keeps the wake indicator active while sleeping polls still report stale idle state', async () => {
    const sleeping = detail([msg('a', 1000)], false, 'sleeping');
    mocks.getChatSession.mockResolvedValue(sleeping);
    mocks.sendFollowUpPrompt.mockResolvedValue({ accepted: true, status: 'queued' });
    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    act(() => result.current.setFollowUp('Wake and continue'));
    act(() => {
      void result.current.handleSendFollowUp();
    });

    await waitFor(() => expect(mocks.sendFollowUpPrompt).toHaveBeenCalled());
    await waitFor(() => expect(mocks.getChatSession.mock.calls.length).toBeGreaterThan(2));
    expect(result.current.agentActivity).toBe('prompting');
  });

  it('surfaces wake phase for a USER-TRIGGERED wake, through the stale-sleeping guard', async () => {
    // The most common trigger: type into a sleeping session. `handleSendFollowUp`
    // arms `sleepingWakePendingRef`, and for nearly the whole wake the guard
    // condition holds (status stays `sleeping`, activity stays `idle`). That
    // branch calls only `hydratePlan`, so without an explicit `hydrateWakeProgress`
    // there it silently discards every `wakePhase`/`recoveryStatus` the poll
    // carries — `isWaking` never flips, the socket gate never opens, and the push
    // half of the feature is dead on the path users actually take.
    //
    // Ordering is load-bearing: `isWaking` is sticky, so if any wake-bearing
    // response lands BEFORE the guard is armed the hook latches on through the
    // normal path and this test stops discriminating. The flag below guarantees
    // every pre-send response is wake-free.
    const sleeping = detail([msg('a', 1000)], false, 'sleeping');
    const waking = {
      ...sleeping,
      state: { ...sleeping.state, recoveryStatus: 'waking', wakePhase: 'node_provisioning' },
    };
    let wakeInFlight = false;
    mocks.getChatSession.mockImplementation(async () => (wakeInFlight ? waking : sleeping));
    mocks.sendFollowUpPrompt.mockResolvedValue({ accepted: true, status: 'queued' });

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    expect(result.current.isWaking).toBe(false);

    act(() => result.current.setFollowUp('Wake and continue'));
    await act(async () => {
      await result.current.handleSendFollowUp();
    });
    await waitFor(() => expect(mocks.sendFollowUpPrompt).toHaveBeenCalled());

    // Only now does the server start reporting the wake — after the guard is armed.
    wakeInFlight = true;

    await waitFor(() => expect(result.current.isWaking).toBe(true));
    await waitFor(() => expect(result.current.wakePhase).toBe('node_provisioning'));
    await waitFor(() => expect(mocks.wsOptions.at(-1)?.enabled).toBe(true));
    // The pre-existing guard must still do its job: activity is not reset to idle.
    expect(result.current.agentActivity).not.toBe('idle');
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
    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

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

  it('hydrates recoveryStatus=waking into agentActivity=recovering so wake banner persists across navigation', async () => {
    const wakingDetail = {
      session: sessionResponse('sleeping'),
      messages: [msg('a', 1000)],
      hasMore: false,
      state: {
        activity: 'idle' as const,
        activityAt: Date.now(),
        statusError: null,
        currentPlan: null,
        planUpdatedAt: null,
        promptStartedAt: null,
        agentType: null,
        lastStopReason: null,
        recoveryStatus: 'waking' as const,
      },
    };
    mocks.getChatSession.mockResolvedValue(wakingDetail);

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    expect(result.current.agentActivity).toBe('recovering');
  });

  it('does NOT set agentActivity=recovering when recoveryStatus is null (normal sleeping)', async () => {
    const normalSleeping = detail([msg('a', 1000)], false, 'sleeping');
    mocks.getChatSession.mockResolvedValue(normalSleeping);

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    expect(result.current.agentActivity).toBe('idle');
  });

  describe('loadUntil', () => {
    it('short-circuits (no fetch) when the target timestamp is already loaded', async () => {
      mocks.getChatSession.mockResolvedValue(detail([msg('a', 500), msg('b', 1000)], false));
      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
        wrapper,
      });
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
      const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
        wrapper,
      });
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
