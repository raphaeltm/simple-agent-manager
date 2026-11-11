/**
 * An open chat must learn that the server put its session to sleep.
 *
 * Staging (PR #2627, D8): the chat was open and active, the server slept it, and the tab
 * kept an active composer for minutes. A connected active session does not poll; it relies
 * on the socket, and the socket dropped the `status` the DO pushes in `session.updated`
 * (`applySessionSleep`). The user's next message then went out as an ordinary prompt
 * instead of a wake, so the wake banner never appeared for the second wake.
 *
 * These tests drive the real socket hook through a fake `WebSocket` and push the exact frame
 * the DO broadcasts (`{ type, payload }`).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  listChatMessages: vi.fn(),
  getSessionAccess: vi.fn(),
  startVerifyDecayTimer: vi.fn(),
  stopVerifyDecayTimer: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  listChatMessages: mocks.listChatMessages,
  getSessionAccess: mocks.getSessionAccess,
  getWorkspace: vi.fn(),
  getNode: vi.fn(),
  getTerminalToken: vi.fn(),
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  cancelAgentPrompt: vi.fn(),
  uploadSessionFiles: vi.fn(),
  requestAttachmentUpload: vi.fn(),
  uploadAttachmentToR2: vi.fn(),
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
  // Keep the fallback poll out: the push alone must move the tab, as on staging.
  CHAT_FALLBACK_POLL_MS: 600_000,
}));

import { useSessionLifecycle } from '../../../src/components/project-message-view/useSessionLifecycle';
import type { ChatMessageResponse, ChatSessionResponse } from '../../../src/lib/api';
import { FakeWebSocket } from '../helpers/fake-websocket';

const reply: ChatMessageResponse = {
  id: 'm1',
  sessionId: 'sess-1',
  role: 'assistant',
  content: 'pong',
  toolMetadata: null,
  createdAt: 1000,
  sequence: 1000,
};

interface DetailOptions {
  status?: string;
  topic?: string;
  agentCompletedAt?: number | null;
  wake?: { attemptId: string; phase: string } | null;
}

function detail({
  status = 'active',
  topic = 'T',
  agentCompletedAt = null,
  wake = null,
}: DetailOptions = {}) {
  const session = {
    id: 'sess-1',
    workspaceId: 'ws-1',
    topic,
    status,
    messageCount: 1,
    startedAt: 0,
    endedAt: null,
    createdAt: 0,
    agentCompletedAt,
    viewerAccess: 'owner',
  } as ChatSessionResponse;
  return {
    session,
    messages: [reply],
    hasMore: false,
    state: {
      activity: 'idle',
      activityAt: 0,
      statusError: null,
      currentPlan: null,
      planUpdatedAt: null,
      promptStartedAt: null,
      agentType: null,
      lastStopReason: null,
      ...(wake
        ? { recoveryStatus: 'waking', wakeAttemptId: wake.attemptId, wakePhase: wake.phase }
        : {}),
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function sessionUpdated(payload: Record<string, unknown>) {
  return { type: 'session.updated', payload: { sessionId: 'sess-1', ...payload } };
}

describe('server-side sleep pushed to an open chat', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // Reset, not just clear: a queued one-shot read left by one test must not leak into the next.
    mocks.getChatSession.mockReset();
    mocks.getChatSession.mockResolvedValue(detail());
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderConnected() {
    const view = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), { wrapper });
    await waitFor(() => expect(view.result.current.messages.map((m) => m.id)).toEqual(['m1']));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    // Liveness: the tab really is showing a live, active chat before the push.
    expect(view.result.current.sessionState).toBe('active');
    return { ...view, socket };
  }

  it('shows the chat as sleeping and closes the socket when the DO pushes the sleep', async () => {
    const { result, socket } = await renderConnected();
    // What the server returns once the session has slept.
    mocks.getChatSession.mockResolvedValue(detail({ status: 'sleeping' }));

    act(() => socket.deliver(sessionUpdated({ status: 'sleeping' })));

    await waitFor(() => expect(result.current.sessionState).toBe('sleeping'));
    // The socket is gated on an active (or waking) session, so a slept chat lets go of it;
    // with `sleeping` as its state, the composer offers to wake the agent.
    await waitFor(() => expect(socket.readyState).toBe(FakeWebSocket.CLOSED));
    // The transcript is still on screen.
    expect(result.current.messages.map((m) => m.id)).toEqual(['m1']);
  });

  it('shows a woken chat as active at once, then catches up on the rest of the session', async () => {
    // A wake in flight in this tab: the chat is sleeping, the previous turn completed, and
    // the socket is open because the wake is waking.
    mocks.getChatSession.mockResolvedValueOnce(
      detail({
        status: 'sleeping',
        agentCompletedAt: 900,
        wake: { attemptId: '01WAKEATTEMPT', phase: 'agent_session' },
      })
    );
    const view = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), { wrapper });
    const { result } = view;
    await waitFor(() => expect(result.current.isWaking).toBe(true));
    expect(result.current.sessionState).toBe('sleeping');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());

    // The reconcile read is held open so the pushed state alone can be observed.
    const reconcileRead = deferred<ReturnType<typeof detail>>();
    mocks.getChatSession.mockReturnValueOnce(reconcileRead.promise);
    const callsBefore = mocks.getChatSession.mock.calls.length;

    // `wakeSession` pushes the new status; on the server it also cleared agent_completed_at.
    act(() => socket.deliver(sessionUpdated({ status: 'active', workspaceId: 'ws-2' })));

    // Not `idle`: the previous turn's completion must not survive the wake.
    await waitFor(() => expect(result.current.sessionState).toBe('active'));
    expect(result.current.session?.agentCompletedAt).toBeNull();
    expect(result.current.session?.workspaceId).toBe('ws-2');
    await waitFor(() => expect(mocks.getChatSession.mock.calls.length).toBe(callsBefore + 1));

    await act(async () => {
      reconcileRead.resolve(detail({ status: 'active', topic: 'Caught up' }));
      await reconcileRead.promise;
    });

    // Fields the push did not carry arrive from the reconcile read.
    await waitFor(() => expect(result.current.session?.topic).toBe('Caught up'));
    expect(result.current.sessionState).toBe('active');
  });

  it('ignores a status the DO does not push on session.updated', async () => {
    const { result, socket } = await renderConnected();

    act(() => socket.deliver(sessionUpdated({ status: 'stopped', topic: 'Renamed' })));

    // The valid field in the same push still lands, so the push was processed.
    await waitFor(() => expect(result.current.session?.topic).toBe('Renamed'));
    expect(result.current.sessionState).toBe('active');
    expect(socket.readyState).toBe(FakeWebSocket.OPEN);
  });

  it('ignores a sleep pushed for another session', async () => {
    const { result, socket } = await renderConnected();

    act(() =>
      socket.deliver({
        type: 'session.updated',
        payload: { sessionId: 'sess-2', status: 'sleeping' },
      })
    );
    act(() => socket.deliver(sessionUpdated({ topic: 'Still mine' })));

    await waitFor(() => expect(result.current.session?.topic).toBe('Still mine'));
    expect(result.current.sessionState).toBe('active');
  });
});
