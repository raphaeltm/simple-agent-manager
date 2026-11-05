/**
 * What became of a message sent with "Steer now", end to end on the web side: the real
 * lifecycle hook, the real chat socket (over a fake WebSocket) and the real transcript cache.
 * The server's own events drive every state, in the shapes the ProjectData DO broadcasts
 * (`message.new` from `acceptPromptDelivery`, `mailbox.delivery_updated` from
 * `deliveryUpdateForResult`).
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

import { userMessageDelivery } from '../../../src/components/project-message-view/message-attribution';
import { useSessionLifecycle } from '../../../src/components/project-message-view/useSessionLifecycle';
import type { ChatSessionResponse } from '../../../src/lib/api';

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

function workingSession() {
  return {
    session: {
      id: 'sess-1',
      workspaceId: null,
      topic: 'T',
      status: 'active',
      messageCount: 0,
      startedAt: 0,
      endedAt: null,
      createdAt: 0,
      viewerAccess: 'owner',
    } as ChatSessionResponse,
    messages: [],
    hasMore: false,
    state: {
      activity: 'prompting',
      activityAt: 1,
      statusError: null,
      currentPlan: null,
      planUpdatedAt: null,
      promptStartedAt: 1,
      agentType: null,
      lastStopReason: null,
    },
  };
}

describe('steer delivery state on the transcript row', () => {
  let queryClient: QueryClient;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);

  beforeEach(() => {
    vi.clearAllMocks();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.getChatSession.mockResolvedValue(workingSession());
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function sendWhileWorking(intent?: 'steer' | 'queue') {
    const api = await import('../../../src/lib/api');
    vi.mocked(api.sendFollowUpPrompt).mockResolvedValue({ status: 'queued' });
    const hook = renderHook(() => useSessionLifecycle('proj-1', 'sess-1', false), { wrapper });
    await waitFor(() => expect(hook.result.current.agentActivity).toBe('prompting'));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => socket.open());
    act(() => hook.result.current.setFollowUp('use tabs, not spaces'));
    await act(async () => {
      await hook.result.current.handleSendFollowUp(intent);
    });
    return { ...hook, socket, sendFollowUpPrompt: vi.mocked(api.sendFollowUpPrompt) };
  }

  const userRow = (messages: { role: string }[]) => messages.find((m) => m.role === 'user')!;

  function serverRow(socket: FakeWebSocket, toolMetadata: Record<string, unknown>) {
    act(() =>
      socket.deliver({
        type: 'message.new',
        payload: {
          sessionId: 'sess-1',
          messageId: 'transcript-1',
          role: 'user',
          content: 'use tabs, not spaces',
          toolMetadata,
          createdAt: Date.now(),
          sequence: 5,
        },
      })
    );
  }

  function deliveryUpdate(socket: FakeWebSocket, payload: Record<string, unknown>) {
    act(() =>
      socket.deliver({
        type: 'mailbox.delivery_updated',
        payload: { messageId: 'delivery-1', promptMessageId: 'transcript-1', ...payload },
      })
    );
  }

  it('sends a steer, shows it steering, then shows it added to the current turn', async () => {
    const { result, socket, sendFollowUpPrompt } = await sendWhileWorking('steer');
    expect(sendFollowUpPrompt).toHaveBeenCalledWith(
      'proj-1',
      'sess-1',
      'use tabs, not spaces',
      [],
      'steer'
    );
    // The optimistic row says "steering" before the server answers.
    expect(userMessageDelivery(userRow(result.current.messages))).toEqual({ status: 'steering' });

    serverRow(socket, {
      kind: 'durable_prompt_delivery',
      deliveryId: 'delivery-1',
      deliveryIntent: 'steer',
    });
    await waitFor(() => expect(userRow(result.current.messages).id).toBe('transcript-1'));
    expect(userMessageDelivery(userRow(result.current.messages))).toEqual({ status: 'steering' });

    deliveryUpdate(socket, {
      deliveryIntent: 'steer',
      deliveryState: 'acked',
      steerOutcome: 'steered',
    });
    await waitFor(() =>
      expect(userMessageDelivery(userRow(result.current.messages))).toEqual({ status: 'steered' })
    );
    expect(result.current.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('shows a steer that became the next message, and then one that was never delivered', async () => {
    const { result, socket } = await sendWhileWorking('steer');
    serverRow(socket, {
      kind: 'durable_prompt_delivery',
      deliveryId: 'delivery-1',
      deliveryIntent: 'steer',
    });
    deliveryUpdate(socket, {
      deliveryIntent: 'queue',
      deliveryState: 'queued',
      steerOutcome: 'queued_fallback',
      steerReason: 'no_running_turn',
    });
    await waitFor(() =>
      expect(userMessageDelivery(userRow(result.current.messages))).toEqual({
        status: 'queued_instead',
        reason: 'turn_finished',
      })
    );
    // The fallback is an ordinary queued delivery now; its failure still reaches the row.
    deliveryUpdate(socket, { deliveryIntent: 'queue', deliveryState: 'failed' });
    await waitFor(() =>
      expect(userMessageDelivery(userRow(result.current.messages))).toEqual({
        status: 'not_delivered',
      })
    );
  });

  it('queues by default and shows no delivery state for an ordinary message', async () => {
    const { result, socket, sendFollowUpPrompt } = await sendWhileWorking();
    expect(sendFollowUpPrompt).toHaveBeenLastCalledWith(
      'proj-1',
      'sess-1',
      'use tabs, not spaces',
      [],
      'queue'
    );
    serverRow(socket, { kind: 'durable_prompt_delivery', deliveryId: 'delivery-1' });
    deliveryUpdate(socket, { deliveryIntent: 'queue', deliveryState: 'failed' });
    await waitFor(() => expect(userRow(result.current.messages).id).toBe('transcript-1'));
    // Liveness: the update reached the row (it carries the label), but nothing renders.
    await waitFor(() =>
      expect(userRow(result.current.messages).toolMetadata).toMatchObject({
        steerOutcome: 'failed',
      })
    );
    expect(userMessageDelivery(userRow(result.current.messages))).toBeUndefined();
  });
});
