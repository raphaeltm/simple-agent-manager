/**
 * A chat opens on its newest page. These tests pin how the rest of its history
 * arrives: when the reader scrolls up to the top, and when a jump targets a
 * message older than anything loaded. Both are reached through their real
 * triggers — the reader's wheel scroll, Virtuoso's `startReached` callback, and
 * the comments drawer's "Show in conversation" — against a server that pages by
 * the same cursors the API uses.
 */
import { DEFAULT_CHAT_SESSION_MESSAGE_LIMIT } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { MemoryRouter } from 'react-router';
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
import { VIRTUAL_START } from '../../../src/components/project-message-view/types';
import {
  resetVirtuosoMock,
  scrollToIndexCalls,
  virtuosoLastProps,
} from '../../helpers/virtuoso-mock';

const SESSION_ID = 'sess-history';

type Row = {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  toolMetadata: null;
  createdAt: number;
  sequence: number;
};

/** A persisted user message; user rows render one bubble each. */
function row(n: number): Row {
  return {
    id: `m${n}`,
    sessionId: SESSION_ID,
    role: 'user',
    content: `Message number ${n}`,
    toolMetadata: null,
    createdAt: n * 1_000,
    sequence: n,
  };
}

const SESSION = {
  id: SESSION_ID,
  workspaceId: null,
  topic: 'A long conversation',
  status: 'stopped',
  messageCount: 6,
  startedAt: 1,
  endedAt: 2,
  createdAt: 1,
};

/**
 * Serves `transcript` the way the session endpoint does: no cursor → the newest
 * `pageSize` rows; `before` → the `pageSize` rows just older than the cursor.
 */
function serveTranscript(transcript: Row[], pageSize: number) {
  mocks.getChatSession.mockImplementation(
    async (_projectId: string, _sessionId: string, params: { before?: string } = {}) => {
      const end = params.before
        ? transcript.findIndex((message) => params.before?.includes(`"${message.id}"`))
        : transcript.length;
      const start = Math.max(0, end - pageSize);
      return {
        session: SESSION,
        messages: transcript.slice(start, end),
        hasMore: start > 0,
        state: null,
      };
    }
  );
}

function beforeCursors(): Array<string | undefined> {
  return mocks.getChatSession.mock.calls.map(
    ([, , params]: [string, string, { before?: string } | undefined]) => params?.before
  );
}

function renderView(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetVirtuosoMock();
  mocks.listMessageComments.mockResolvedValue({ comments: [] });
});

describe('ProjectMessageView — history arrives newest first', () => {
  it('opens on the newest page, then pages older history in when the reader reaches the top', async () => {
    serveTranscript([row(1), row(2), row(3), row(4)], 2);

    renderView(<ProjectMessageView projectId="proj-1" sessionId={SESSION_ID} />);

    expect(await screen.findByText('Message number 4')).toBeInTheDocument();
    expect(screen.getByText('Message number 3')).toBeInTheDocument();
    expect(screen.queryByText('Message number 2')).not.toBeInTheDocument();
    expect(mocks.getChatSession).toHaveBeenCalledTimes(1);
    expect(mocks.getChatSession).toHaveBeenCalledWith('proj-1', SESSION_ID, {
      signal: expect.any(AbortSignal),
      limit: DEFAULT_CHAT_SESSION_MESSAGE_LIMIT,
    });
    expect(virtuosoLastProps.firstItemIndex).toBe(VIRTUAL_START);

    // Until the reader scrolls up, reaching the top pages nothing in: a page that
    // fits on screen shows its first row at once, and a chat whose newest message
    // is taller than the screen opens away from the bottom — neither is the reader.
    expect(virtuosoLastProps.startReached).toBeUndefined();
    act(() => {
      virtuosoLastProps.atBottomStateChange?.(false);
    });
    expect(virtuosoLastProps.startReached).toBeUndefined();

    // The reader scrolls up, on to the top of what is loaded. Virtuoso ignores what
    // the callback returns, so neither does this call.
    fireEvent.wheel(screen.getByRole('log', { name: 'Conversation' }), { deltaY: -120 });
    expect(virtuosoLastProps.startReached).toBeTypeOf('function');
    act(() => {
      virtuosoLastProps.startReached?.();
    });

    expect(await screen.findByText('Message number 1')).toBeInTheDocument();
    expect(screen.getByText('Message number 2')).toBeInTheDocument();
    expect(beforeCursors()).toEqual([undefined, '[3000,3,"m3"]']);
    // Two rows arrived at the front, so the list's anchor moved by exactly two:
    // the rows the reader was looking at keep their absolute index.
    await waitFor(() => expect(virtuosoLastProps.firstItemIndex).toBe(VIRTUAL_START - 2));
    // Nothing older remains, so reaching the top again asks for nothing.
    expect(virtuosoLastProps.startReached).toBeUndefined();
  });

  it('jumps to a comment on a message older than the loaded window, paging back until that message loads', async () => {
    serveTranscript([row(1), row(2), row(3), row(4), row(5), row(6)], 2);
    mocks.listMessageComments.mockResolvedValue({
      comments: [
        {
          id: 'comment-on-m2',
          clientId: null,
          projectId: 'proj-1',
          sessionId: SESSION_ID,
          // No quote, so the row falls back to describing the anchor.
          anchor: { kind: 'message', messageId: 'm2', quote: '' },
          author: { id: 'user-1', name: 'Test User', email: 't@x', avatarUrl: null, kind: 'human' },
          body: 'Worth revisiting this early decision.',
          // Written long after m2, and after everything loaded: a jump that stopped
          // at this time would not load m2 at all.
          createdAt: 9_000,
          updatedAt: 9_000,
          status: 'open',
          replies: [],
        },
      ],
    });

    renderView(<ProjectMessageView projectId="proj-1" sessionId={SESSION_ID} />);
    expect(await screen.findByText('Message number 6')).toBeInTheDocument();

    fireEvent.click(await screen.findByRole('button', { name: /1 unresolved comment/i }));
    const threadRow = await screen.findByRole('button', {
      name: /Worth revisiting this early decision\./i,
    });
    // m2 is not loaded, so who wrote it is unknown and the row does not guess.
    expect(within(threadRow).getByText('on a message')).toBeInTheDocument();
    fireEvent.click(threadRow);
    fireEvent.click(screen.getByRole('button', { name: /show in conversation/i }));

    expect(await screen.findByText('Message number 2')).toBeInTheDocument();
    expect(beforeCursors()).toEqual([undefined, '[5000,5,"m5"]', '[3000,3,"m3"]']);
    // m2 sits at 0-based index 1 of the six loaded rows. The nearest-by-time
    // fallback would have picked the newest row (5), and a firstItemIndex-offset
    // coordinate would be ~100 000.
    await waitFor(() =>
      expect(scrollToIndexCalls.at(-1)).toMatchObject({ index: 1, align: 'center' })
    );
  });

  it('scrolls again until a row that arrived with older history stays on screen', async () => {
    serveTranscript([row(1), row(2), row(3), row(4), row(5), row(6)], 2);
    mocks.listMessageComments.mockResolvedValue({
      comments: [
        {
          id: 'comment-on-m2',
          clientId: null,
          projectId: 'proj-1',
          sessionId: SESSION_ID,
          anchor: { kind: 'message', messageId: 'm2', quote: '' },
          author: { id: 'user-1', name: 'Test User', email: 't@x', avatarUrl: null, kind: 'human' },
          body: 'Worth revisiting this early decision.',
          createdAt: 9_000,
          updatedAt: 9_000,
          status: 'open',
          replies: [],
        },
      ],
    });
    // In a browser the list shifts to keep its rows in place when older pages
    // arrive, which can carry the first scroll's target back off screen. Here the
    // target row reads as off screen for its first two checks.
    let offScreenReads = 2;
    const realRect = Element.prototype.getBoundingClientRect;
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      if (this.getAttribute('data-index') === '1' && offScreenReads > 0) {
        offScreenReads -= 1;
        return {
          top: 5_000,
          bottom: 5_100,
          left: 0,
          right: 0,
          width: 0,
          height: 100,
          x: 0,
          y: 5_000,
          toJSON: () => ({}),
        };
      }
      return realRect.call(this);
    });

    renderView(<ProjectMessageView projectId="proj-1" sessionId={SESSION_ID} />);
    expect(await screen.findByText('Message number 6')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /1 unresolved comment/i }));
    fireEvent.click(
      await screen.findByRole('button', { name: /Worth revisiting this early decision\./i })
    );
    fireEvent.click(screen.getByRole('button', { name: /show in conversation/i }));

    expect(await screen.findByText('Message number 2')).toBeInTheDocument();
    await waitFor(() => expect(offScreenReads).toBe(0));
    await waitFor(() =>
      expect(
        scrollToIndexCalls.filter((call) => typeof call === 'object' && call.index === 1).length
      ).toBeGreaterThanOrEqual(3)
    );
    rect.mockRestore();
  });
});
