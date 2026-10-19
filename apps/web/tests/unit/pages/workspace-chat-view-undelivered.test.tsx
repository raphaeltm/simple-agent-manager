/**
 * The workspace page's chat must label a teammate's prompt that was never delivered, like the
 * project chat does. The server labels the stored row, but this view never re-reads a row it
 * already shows, so the label comes from the access summary's `undelivered` list: from the
 * session read on load, and from the access read that every `session.access.changed` frame
 * triggers while the page is open.
 *
 * Driven through the real `WorkspaceChatView`, the real chat socket hook and a fake `WebSocket`
 * (rule 62): the frame arrives the way the ProjectData DO sends it.
 */
import type { SessionAccessSummary, SessionUndeliveredPrompt } from '@simple-agent-manager/shared';
import { act, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  getChatSessionState: vi.fn(),
  getSessionAccess: vi.fn(),
  listChatMessages: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getChatSessionState: mocks.getChatSessionState,
  getSessionAccess: mocks.getSessionAccess,
  listChatMessages: mocks.listChatMessages,
  getTranscribeApiUrl: vi.fn(() => 'https://api.test/api/transcribe'),
  getTtsApiUrl: vi.fn(() => 'https://api.test/api/tts'),
  resetIdleTimer: vi.fn(),
  sendFollowUpPrompt: vi.fn(),
  uploadSessionFiles: vi.fn(),
  cancelAgentPrompt: vi.fn(),
}));

vi.mock('../../../src/contexts/GlobalAudioContext', () => ({
  useGlobalAudio: () => ({ startPlayback: vi.fn() }),
}));

vi.mock('react-virtuoso', async () => {
  const { createVirtuosoModuleMock } = await import('../../helpers/virtuoso-mock');
  return createVirtuosoModuleMock();
});

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simple-agent-manager/acp-client')>();
  return {
    ...actual,
    MessageBubble: ({ text, role }: { text: string; role: string }) => (
      <div data-testid={`acp-message-${role}`}>{text}</div>
    ),
  };
});

const { WorkspaceChatView } = await import('../../../src/pages/workspace/WorkspaceChatView');
const { resetVirtuosoMock } = await import('../../helpers/virtuoso-mock');

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

const SESSION_ID = 'ws-session-1';
const EXPIRED: SessionUndeliveredPrompt = {
  messageId: 'queued',
  reason: 'sender_access_expired',
};

function userRow(id: string, content: string, createdAt: number, fromTeammate: boolean) {
  return {
    id,
    sessionId: SESSION_ID,
    role: 'user',
    content,
    toolMetadata: fromTeammate
      ? {
          kind: 'durable_prompt_delivery',
          deliveryId: `delivery-${id}`,
          source: 'user_followup',
          userId: 'grantee-1',
          senderName: 'Ana Ruiz',
          onBehalfOfUserId: 'owner-1',
          grantId: 'grant-1',
        }
      : null,
    createdAt,
    sequence: createdAt,
  };
}

function access(undelivered: SessionUndeliveredPrompt[]): SessionAccessSummary {
  return {
    sessionId: SESSION_ID,
    viewerAccess: 'owner',
    owner: { id: 'owner-1', name: 'Owner', email: null, avatarUrl: null },
    // Ended grants are not listed, so no end-time refetch is armed.
    grants: [],
    undelivered,
    serverTime: 10_000,
  };
}

function sessionRead(undelivered: SessionUndeliveredPrompt[]) {
  return {
    session: {
      id: SESSION_ID,
      workspaceId: 'ws-1',
      topic: 'Shared chat',
      status: 'active',
      messageCount: 3,
      createdAt: 1_000,
      endedAt: null,
      viewerAccess: 'owner',
      access: access(undelivered),
    },
    messages: [
      userRow('own', 'Owner prompt', 1_000, false),
      userRow('sent', 'Teammate prompt that was delivered', 2_000, true),
      userRow('queued', 'Teammate prompt still queued', 3_000, true),
    ],
    hasMore: false,
    state: null,
  };
}

function renderView() {
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter>{children}</MemoryRouter>
  );
  return render(<WorkspaceChatView projectId="proj-1" sessionId={SESSION_ID} />, {
    wrapper: Wrapper,
  });
}

describe('WorkspaceChatView — prompts that were never delivered', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetVirtuosoMock();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    mocks.getChatSessionState.mockResolvedValue({
      state: null,
      agentSessionId: null,
      agentType: null,
    });
    mocks.listChatMessages.mockResolvedValue({ messages: [], hasMore: false });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('labels a prompt the session read lists as cancelled', async () => {
    mocks.getChatSession.mockResolvedValue(sessionRead([EXPIRED]));
    renderView();

    expect(await screen.findByText('Not delivered — access expired')).toBeInTheDocument();
    // Only the cancelled row is labelled; both teammate rows still name their sender.
    expect(screen.getAllByText('Not delivered — access expired')).toHaveLength(1);
    expect(screen.getAllByText('Ana Ruiz · shared access')).toHaveLength(2);
  });

  it('labels it on the open page when the server says access changed', async () => {
    mocks.getChatSession.mockResolvedValue(sessionRead([]));
    mocks.getSessionAccess.mockResolvedValue(access([EXPIRED]));
    renderView();

    // Liveness: the teammate rows rendered, unlabelled, before anything changed.
    expect(await screen.findAllByText('Ana Ruiz · shared access')).toHaveLength(2);
    expect(screen.queryByText('Not delivered — access expired')).toBeNull();

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
    });
    act(() => {
      socket.deliver({
        type: 'session.access.changed',
        payload: { sessionId: SESSION_ID, reason: 'expired' },
      });
    });

    expect(await screen.findByText('Not delivered — access expired')).toBeInTheDocument();
    expect(mocks.getSessionAccess).toHaveBeenCalledWith('proj-1', SESSION_ID);
    // The label came from the access read, not a reload of the transcript.
    expect(mocks.getChatSession).toHaveBeenCalledTimes(1);
  });

  it("ignores another session's access change", async () => {
    mocks.getChatSession.mockResolvedValue(sessionRead([]));
    mocks.getSessionAccess.mockResolvedValue(access([EXPIRED]));
    renderView();

    expect(await screen.findAllByText('Ana Ruiz · shared access')).toHaveLength(2);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const socket = FakeWebSocket.instances[0]!;
    act(() => {
      socket.open();
      socket.deliver({
        type: 'session.access.changed',
        payload: { sessionId: 'other-session', reason: 'expired' },
      });
    });

    expect(mocks.getSessionAccess).not.toHaveBeenCalled();
    expect(screen.queryByText('Not delivered — access expired')).toBeNull();
  });
});
