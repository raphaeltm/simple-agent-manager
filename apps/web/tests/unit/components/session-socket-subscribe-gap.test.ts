/**
 * A row persisted after a chat's REST read and before its socket subscribed reached no socket.
 *
 * Staging found this with a comment sent to the agent right after the chat loaded: the
 * directive row was never shown, live or after a reload, while the agent's reply to it was.
 * The reply arrived on the socket, so every later read resumed after the reply and the
 * directive stayed a permanent hole in the cached transcript.
 *
 * These tests drive the real socket hook through a fake `WebSocket` and the real transcript
 * cache, and own the ordering: the load resolves, the row is persisted, the socket opens, a
 * live row lands while the read is in flight, and only then does the read resolve.
 */
import { DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createElement, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  listChatMessages: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  listChatMessages: mocks.listChatMessages,
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
    startVerifyDecayTimer: vi.fn(),
    stopVerifyDecayTimer: vi.fn(),
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
  // Keep the fallback poll out of these tests: its newest-window read would also find the
  // missed row and hide whether the subscribe read did.
  CHAT_FALLBACK_POLL_MS: 600_000,
}));

import { useSessionLifecycle } from '../../../src/components/project-message-view/useSessionLifecycle';
import type { ChatMessageResponse, ChatSessionResponse } from '../../../src/lib/api';
import { chatQueryKeys } from '../../../src/lib/query-options';
import { useWorkspaceChatSocket } from '../../../src/pages/workspace/useWorkspaceChatSocket';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send() {}

  close(code = 1000) {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code });
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.({});
  }

  deliver(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

function row(id: string, role: string, createdAt: number): ChatMessageResponse {
  return {
    id,
    sessionId: 'sess-1',
    role,
    content: `${role} ${id}`,
    toolMetadata: null,
    createdAt,
    sequence: createdAt,
  };
}

function session(status: string): ChatSessionResponse {
  return {
    id: 'sess-1',
    workspaceId: null,
    topic: 'T',
    status,
    messageCount: 2,
    startedAt: 0,
    endedAt: null,
    createdAt: 0,
  } as ChatSessionResponse;
}

function detail(messages: ChatMessageResponse[]) {
  return {
    session: session('active'),
    messages,
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

const ownerPrompt = row('m1', 'user', 1000);
const agentReply = row('m2', 'assistant', 2000);
// Persisted by Send to agent after the page's read, before its socket subscribed.
const directive = row('comment-directive-t1', 'user', 3000);
// The agent's reply to the directive, which does reach the socket.
const replyToDirective = row('r4', 'assistant', 4000);

function liveBatch(message: ChatMessageResponse) {
  return { type: 'messages.batch', payload: { sessionId: 'sess-1', messages: [message] } };
}

function messagesPage(messages: ChatMessageResponse[]) {
  return { messages, hasMore: false };
}

describe('rows persisted between the last read and the socket subscription', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('project chat: shows the row and keeps it in order with the live row after it', async () => {
    const subscribeRead = deferred<ReturnType<typeof messagesPage>>();
    mocks.getChatSession.mockResolvedValueOnce(detail([ownerPrompt, agentReply]));
    mocks.listChatMessages.mockReturnValueOnce(subscribeRead.promise);

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2']));
    // The chat is active, so its socket is on its way; the directive is persisted now.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      // A live row lands before the subscribe read has even started.
      socket.deliver(liveBatch(replyToDirective));
    });
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2', 'r4'])
    );

    // The read resumes from the newest row the page had read, not from the live row, and goes
    // through the messages-only route.
    await waitFor(() =>
      expect(mocks.listChatMessages).toHaveBeenCalledWith('proj-1', 'sess-1', {
        after: '[2000,2000,"m2"]',
        limit: DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT,
        signal: undefined,
      })
    );

    await act(async () => {
      subscribeRead.resolve(messagesPage([directive]));
      await subscribeRead.promise;
    });

    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm1',
        'm2',
        'comment-directive-t1',
        'r4',
      ])
    );
    expect(mocks.getChatSession).toHaveBeenCalledTimes(1);
    expect(mocks.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('project chat, cached transcript: waits for the mount refresh instead of reading its range twice', async () => {
    // Reopening a chat whose transcript is cached: the mount refresh is still reading what was
    // persisted while it was closed when the socket opens.
    const closedWhile = row('m3', 'user', 3000);
    const gap = row('comment-directive-t4', 'user', 4000);
    const live = row('r5', 'assistant', 5000);
    queryClient.setQueryData(
      chatQueryKeys.sessionMessages('user-1', 'proj-1', 'sess-1'),
      detail([ownerPrompt, agentReply])
    );
    const mountRefresh = deferred<ReturnType<typeof detail>>();
    mocks.getChatSession.mockReturnValueOnce(mountRefresh.promise);
    mocks.listChatMessages.mockResolvedValueOnce(messagesPage([gap]));

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });
    await waitFor(() => expect(mocks.getChatSession).toHaveBeenCalledTimes(1));
    expect(mocks.getChatSession).toHaveBeenLastCalledWith('proj-1', 'sess-1', {
      signal: expect.any(AbortSignal),
      after: '[2000,2000,"m2"]',
    });
    // The cached session is active, so the socket opens while the refresh is in flight.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.open();
      await Promise.resolve();
      socket.deliver(liveBatch(live));
      await Promise.resolve();
    });
    expect(mocks.listChatMessages).not.toHaveBeenCalled();

    await act(async () => {
      mountRefresh.resolve(detail([closedWhile]));
      await mountRefresh.promise;
    });

    // Resumes after the refresh's newest row: not m2 (the refresh's own range), and not the
    // live row (which would skip the gap).
    await waitFor(() =>
      expect(mocks.listChatMessages).toHaveBeenCalledWith('proj-1', 'sess-1', {
        after: '[3000,3000,"m3"]',
        limit: DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT,
        signal: undefined,
      })
    );
    await waitFor(() =>
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm1',
        'm2',
        'm3',
        'comment-directive-t4',
        'r5',
      ])
    );
    expect(mocks.getChatSession).toHaveBeenCalledTimes(1);
    expect(mocks.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it('workspace chat: shows the row and keeps it in order with the live row after it', async () => {
    const subscribeRead = deferred<ReturnType<typeof messagesPage>>();
    mocks.listChatMessages.mockReturnValueOnce(subscribeRead.promise);

    const { result } = renderHook(() => {
      const [messages, setMessages] = useState<ChatMessageResponse[]>([ownerPrompt, agentReply]);
      const [, setSession] = useState<ChatSessionResponse | null>(session('active'));
      useWorkspaceChatSocket({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        sessionStatus: 'active',
        messages,
        setMessages,
        setSession,
      });
      return messages;
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;

    act(() => {
      socket.open();
      socket.deliver(liveBatch(replyToDirective));
    });

    expect(mocks.listChatMessages).toHaveBeenCalledWith('proj-1', 'sess-1', {
      after: '[2000,2000,"m2"]',
      limit: DEFAULT_CHAT_SESSION_DELTA_MESSAGE_LIMIT,
      signal: undefined,
    });
    expect(result.current.map((m) => m.id)).toEqual(['m1', 'm2', 'r4']);

    await act(async () => {
      subscribeRead.resolve(messagesPage([directive]));
      await subscribeRead.promise;
    });

    await waitFor(() =>
      expect(result.current.map((m) => m.id)).toEqual(['m1', 'm2', 'comment-directive-t1', 'r4'])
    );
    expect(mocks.getChatSession).not.toHaveBeenCalled();
  });
});
