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
  getSessionAccess: vi.fn(),
  // Stable like the real hook's callbacks: a new identity per render would re-run the
  // lifecycle's server-snapshot effect on every render.
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
  // Keep the fallback poll out of these tests: its newest-window read would also find the
  // missed row and hide whether the subscribe read did.
  CHAT_FALLBACK_POLL_MS: 600_000,
}));

import { useSessionLifecycle } from '../../../src/components/project-message-view/useSessionLifecycle';
import { useProjectWebSocket } from '../../../src/hooks/useProjectWebSocket';
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

type Viewer = 'owner' | 'grantee' | 'reader';

function accessSummary(viewerAccess: Viewer, serverTime: number) {
  const grant = {
    id: 'grant-1',
    grantee: { id: 'mate', name: 'Mate', email: null, avatarUrl: null },
    grantedBy: { id: 'owner', name: 'Owner', email: null, avatarUrl: null },
    createdAt: 0,
    expiresAt: Date.now() + 30 * 60_000,
  };
  return {
    sessionId: 'sess-1',
    viewerAccess,
    owner: { id: 'owner', name: 'Owner', email: null, avatarUrl: null },
    grants: viewerAccess === 'reader' ? [] : [grant],
    serverTime,
  };
}

function session(
  status: string,
  viewerAccess: Viewer = 'owner',
  serverTime = 1
): ChatSessionResponse {
  return {
    id: 'sess-1',
    workspaceId: null,
    topic: 'T',
    status,
    messageCount: 2,
    startedAt: 0,
    endedAt: null,
    createdAt: 0,
    viewerAccess,
    access: accessSummary(viewerAccess, serverTime),
  } as ChatSessionResponse;
}

function detail(messages: ChatMessageResponse[], viewerAccess: Viewer = 'owner', serverTime = 1) {
  return {
    session: session('active', viewerAccess, serverTime),
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

describe('access changed between the last read and the socket subscription', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.listChatMessages.mockResolvedValue(messagesPage([]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("a teammate's page re-reads access when its socket subscribes, so a missed revoke still locks it", async () => {
    // The owner revoked while the teammate's page was loading: the page read them as a grantee,
    // and the revoke's broadcast reached no socket.
    mocks.getChatSession.mockResolvedValueOnce(detail([ownerPrompt, agentReply], 'grantee'));
    mocks.getSessionAccess.mockResolvedValueOnce(accessSummary('reader', 5));

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });
    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('grantee'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();

    act(() => {
      FakeWebSocket.instances[0]!.open();
    });

    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('reader'));
    expect(mocks.getSessionAccess).toHaveBeenCalledWith('proj-1', 'sess-1');
    // Liveness: the same subscription also read the transcript tail.
    expect(mocks.listChatMessages).toHaveBeenCalledTimes(1);
  });

  it("the owner's page does not pay for the access read", async () => {
    mocks.getChatSession.mockResolvedValueOnce(detail([ownerPrompt, agentReply], 'owner'));

    renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), { wrapper });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => {
      FakeWebSocket.instances[0]!.open();
    });

    await waitFor(() => expect(mocks.listChatMessages).toHaveBeenCalledTimes(1));
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();
  });

  it('reads access only after the mount refresh lands, so its older snapshot cannot undo the revoke', async () => {
    queryClient.setQueryData(
      chatQueryKeys.sessionMessages('user-1', 'proj-1', 'sess-1'),
      detail([ownerPrompt, agentReply], 'grantee', 1)
    );
    const mountRefresh = deferred<ReturnType<typeof detail>>();
    mocks.getChatSession.mockReturnValueOnce(mountRefresh.promise);
    const accessRead = deferred<ReturnType<typeof accessSummary>>();
    mocks.getSessionAccess.mockReturnValueOnce(accessRead.promise);

    const { result } = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), {
      wrapper,
    });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await act(async () => {
      FakeWebSocket.instances[0]!.open();
      await Promise.resolve();
    });
    // The refresh built before the revoke is still in flight; reading access now would let it
    // land on top of the answer.
    expect(mocks.getSessionAccess).not.toHaveBeenCalled();

    await act(async () => {
      mountRefresh.resolve(detail([], 'grantee', 2));
      await mountRefresh.promise;
    });
    await waitFor(() => expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1));
    await act(async () => {
      accessRead.resolve(accessSummary('reader', 3));
      await accessRead.promise;
    });

    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('reader'));
  });
});

describe('access changes while the chat sleeps', () => {
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

  it("a revoke reaches a teammate's open page through the project socket", async () => {
    const asleep = detail([ownerPrompt, agentReply], 'grantee');
    asleep.session = { ...asleep.session, status: 'sleeping' };
    mocks.getChatSession.mockResolvedValueOnce(asleep);
    mocks.getSessionAccess.mockResolvedValueOnce(accessSummary('reader', 5));

    const { result } = renderHook(
      () => {
        // The project chat page runs both: the sidebar's project socket and the open chat.
        useProjectWebSocket({ projectId: 'proj-1' });
        return useSessionLifecycle('proj-1', 'sess-1', false);
      },
      { wrapper }
    );
    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('grantee'));
    // Asleep: the chat socket stays off; only the project socket exists.
    expect(FakeWebSocket.instances.map((socket) => socket.url.includes('sessionId='))).toEqual([
      false,
    ]);

    act(() => {
      const projectSocket = FakeWebSocket.instances[0]!;
      projectSocket.open();
      projectSocket.deliver({
        type: 'session.access.changed',
        payload: { sessionId: 'sess-1', reason: 'revoked' },
      });
    });

    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('reader'));
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1);
  });
});

describe('one access read per change', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.listChatMessages.mockResolvedValue(messagesPage([]));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('an active chat hears the change on both sockets but reads access once', async () => {
    mocks.getChatSession.mockResolvedValueOnce(detail([ownerPrompt, agentReply], 'grantee'));
    // The subscribe re-read, then the revoke.
    mocks.getSessionAccess
      .mockResolvedValueOnce(accessSummary('grantee', 2))
      .mockResolvedValueOnce(accessSummary('reader', 5));

    const { result } = renderHook(
      () => {
        useProjectWebSocket({ projectId: 'proj-1' });
        return useSessionLifecycle('proj-1', 'sess-1', false);
      },
      { wrapper }
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    const [projectSocket, chatSocket] = [
      FakeWebSocket.instances.find((socket) => !socket.url.includes('sessionId='))!,
      FakeWebSocket.instances.find((socket) => socket.url.includes('sessionId='))!,
    ];
    act(() => {
      projectSocket.open();
      chatSocket.open();
    });
    await waitFor(() => expect(mocks.getSessionAccess).toHaveBeenCalledTimes(1));

    const revoked = { type: 'session.access.changed', payload: { sessionId: 'sess-1' } };
    act(() => {
      projectSocket.deliver(revoked);
      chatSocket.deliver(revoked);
    });

    await waitFor(() => expect(result.current.session?.viewerAccess).toBe('reader'));
    expect(mocks.getSessionAccess).toHaveBeenCalledTimes(2);
  });
});
