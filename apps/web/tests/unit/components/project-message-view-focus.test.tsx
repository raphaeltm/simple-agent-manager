/**
 * Keyboard focus across a switch between chats.
 *
 * Each chat is its own keyed subtree, so a link inside one chat that opens another
 * is destroyed by the switch it causes. These tests follow that link the way a
 * keyboard user does — focus it, activate it — through the real router, and check
 * where focus lands. A switch started outside the chat must leave focus alone.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSession: vi.fn(),
  listMessageComments: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getChatSession: mocks.getChatSession,
  getReportIssueConfig: vi.fn().mockResolvedValue({ enabled: false }),
  getTranscribeApiUrl: () => 'https://api.test/api/transcribe',
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: mocks.listMessageComments,
}));

vi.mock('../../../src/hooks/useChatWebSocket', () => ({
  useChatWebSocket: () => ({
    connectionState: 'connected',
    wsRef: { current: null },
    retry: vi.fn(),
  }),
}));

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'user-1' }, isSuperadmin: false, isLoading: false }),
}));

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
  MessageBubble: ({ text }: { text: string }) => <div>{text}</div>,
  TypewriterText: ({ text }: { text: string }) => <span>{text}</span>,
}));

vi.mock('react-virtuoso', async () => {
  const { createVirtuosoModuleMock } = await import('../../helpers/virtuoso-mock');
  return createVirtuosoModuleMock();
});

import { ProjectMessageView } from '../../../src/components/project-message-view';
import { resetVirtuosoMock } from '../../helpers/virtuoso-mock';

const TOPICS: Record<string, string> = {
  'sess-parent': 'Parent chat: plan the migration',
  'sess-child': 'Child chat: run the migration',
};

function serveChats() {
  mocks.getChatSession.mockImplementation(async (_projectId: string, sessionId: string) => ({
    session: {
      id: sessionId,
      workspaceId: null,
      topic: TOPICS[sessionId],
      status: 'stopped',
      messageCount: 1,
      startedAt: 1,
      endedAt: 2,
      createdAt: 1,
    },
    messages: [
      {
        id: `${sessionId}-m1`,
        sessionId,
        role: 'user',
        content: `First message of ${sessionId}`,
        toolMetadata: null,
        createdAt: 1_000,
        sequence: 1,
      },
    ],
    hasMore: false,
    state: null,
  }));
}

/** The chat page, reduced to what a switch needs: the route and one control outside the chat. */
function ChatRoute() {
  const { sessionId = '' } = useParams();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/projects/proj-1/chat/sess-child')}>
        Open the child chat
      </button>
      <ProjectMessageView
        projectId="proj-1"
        sessionId={sessionId}
        sourceContext={
          sessionId === 'sess-child'
            ? {
                lineageText: 'Fork of',
                parentTaskId: 'task-parent',
                parentSessionId: 'sess-parent',
                parentTitle: TOPICS['sess-parent']!,
              }
            : undefined
        }
      />
    </>
  );
}

function renderAt(sessionId: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={[`/projects/proj-1/chat/${sessionId}`]}>
      <QueryClientProvider client={client}>
        <Routes>
          <Route path="/projects/:projectId/chat/:sessionId" element={<ChatRoute />} />
        </Routes>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

function sessionTitle(): HTMLElement | undefined {
  return document.activeElement instanceof HTMLElement &&
    document.activeElement.hasAttribute('data-session-title')
    ? document.activeElement
    : undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVirtuosoMock();
  mocks.listMessageComments.mockResolvedValue({ comments: [] });
  serveChats();
});

describe('ProjectMessageView — focus across a switch', () => {
  it('moves focus to the next chat title when a link inside the chat opens it', async () => {
    renderAt('sess-child');
    expect(await screen.findByText('First message of sess-child')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('session-tool-details'));
    const parentLink = await screen.findByRole('link', { name: TOPICS['sess-parent'] });
    parentLink.focus();
    expect(document.activeElement).toBe(parentLink);
    fireEvent.click(parentLink);

    expect(await screen.findByText('First message of sess-parent')).toBeInTheDocument();
    // The link went away with the chat it was in; focus did not fall to the body.
    await waitFor(() => expect(sessionTitle()).toHaveTextContent(TOPICS['sess-parent']!));
    expect(parentLink).not.toBeInTheDocument();
  });

  it('leaves focus where it is when the switch starts outside the chat', async () => {
    renderAt('sess-parent');
    expect(await screen.findByText('First message of sess-parent')).toBeInTheDocument();

    const outside = screen.getByRole('button', { name: 'Open the child chat' });
    outside.focus();
    fireEvent.click(outside);

    expect(await screen.findByText('First message of sess-child')).toBeInTheDocument();
    expect(document.activeElement).toBe(outside);
  });
});
