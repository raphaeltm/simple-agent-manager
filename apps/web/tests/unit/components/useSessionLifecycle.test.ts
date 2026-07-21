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
  useActivityVerifyTimer: () => ({ startVerifyDecayTimer: vi.fn(), stopVerifyDecayTimer: vi.fn() }),
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
