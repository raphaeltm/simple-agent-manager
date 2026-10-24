/**
 * The comment reader, rendered through the real router, TanStack Query client and chat item
 * renderer, against API mocks shaped like the server's responses. It is reached the way a
 * person reaches it: a Comments page row click, a URL, a click on "Earlier messages", a reply
 * from the thread sheet.
 */
import { formatMessageCursor } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMessageCommentContext: vi.fn(),
  listMessageComments: vi.fn(),
  listProjectComments: vi.fn(),
  createMessageCommentReply: vi.fn(),
  resolveMessageCommentThread: vi.fn(),
  reopenMessageCommentThread: vi.fn(),
  sendMessageCommentThreadToAgent: vi.fn(),
  listChatMessages: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  getMessageCommentContext: mocks.getMessageCommentContext,
  listMessageComments: mocks.listMessageComments,
  listProjectComments: mocks.listProjectComments,
  createMessageCommentReply: mocks.createMessageCommentReply,
  resolveMessageCommentThread: mocks.resolveMessageCommentThread,
  reopenMessageCommentThread: mocks.reopenMessageCommentThread,
  sendMessageCommentThreadToAgent: mocks.sendMessageCommentThreadToAgent,
}));

vi.mock('../../../src/lib/api/sessions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/sessions')>()),
  listChatMessages: mocks.listChatMessages,
}));

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'viewer-1' }, isSuperadmin: false, isLoading: false }),
}));

// One stable result: the composer's mention source re-publishes whenever `members` changes.
vi.mock('../../../src/hooks/useProjectMembers', () => {
  const result = { members: [], allMembers: [], isPending: false, error: null };
  return { useProjectMembers: () => result };
});

vi.mock('@simple-agent-manager/acp-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@simple-agent-manager/acp-client')>()),
  VoiceButton: () => null,
  MessageBubble: ({ text }: { text: string }) => <div>{text}</div>,
  TypewriterText: ({ text }: { text: string }) => <span>{text}</span>,
}));

import type { ChatMessageResponse, MessageCommentThread } from '../../../src/lib/api';
import { ApiClientError } from '../../../src/lib/api';
import { ProjectCommentReader } from '../../../src/pages/comment-reader';
import { ProjectComments } from '../../../src/pages/ProjectComments';
import { ProjectContext } from '../../../src/pages/ProjectContext';

const PROJECT = 'proj-1';
const SESSION = 'sess-1';

function row(id: string, role: string, content: string, at: number): ChatMessageResponse {
  return {
    id,
    sessionId: SESSION,
    role,
    content,
    toolMetadata: null,
    createdAt: at,
    sequence: at,
  };
}

/** A question, a reply streamed in three chunks, a follow-up. */
const ROWS = [
  row('u1', 'user', 'Why does the webhook retry?', 100),
  row('a1', 'assistant', 'It retries because ', 200),
  row('a2', 'assistant', 'the handler returns 500 ', 201),
  row('a3', 'assistant', 'before the idempotency check.', 202),
  row('u2', 'user', 'Fix it please.', 300),
];

function makeThread(
  id: string,
  overrides: Partial<MessageCommentThread> = {}
): MessageCommentThread {
  return {
    id,
    projectId: PROJECT,
    sessionId: SESSION,
    // Anchored to the reply's SECOND chunk: the chat's own rows only know the first.
    anchor: { kind: 'message', messageId: 'a2', quote: 'the handler returns 500' },
    author: { id: 'grace', name: 'Grace Hopper', kind: 'human' },
    body: 'Should this be a 409 instead?',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

const THREAD = makeThread('thread-1');

function context(overrides: Record<string, unknown> = {}) {
  return {
    thread: THREAD,
    session: { id: SESSION, topic: 'Webhook retries' },
    viewerAccess: 'owner',
    anchor: { messageId: 'a2', found: true },
    messages: ROWS,
    hasMoreBefore: false,
    hasMoreAfter: false,
    ...overrides,
  };
}

function inboxOf(threads: MessageCommentThread[]) {
  return {
    messageThreads: threads,
    fileThreads: [],
    sessionTopics: new Map([[SESSION, 'Webhook retries']]),
    fileNames: new Map(),
    hasMore: false,
    totalCount: threads.length,
  };
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const projectContext = { projectId: PROJECT, project: null, installations: [], reload: vi.fn() };
  return render(
    <MemoryRouter initialEntries={[path]}>
      <QueryClientProvider client={client}>
        <ProjectContext.Provider value={projectContext}>
          <Routes>
            <Route path="/projects/:id/comments" element={<ProjectComments />} />
            <Route
              path="/projects/:id/comments/:sessionId/:threadId"
              element={<ProjectCommentReader />}
            />
            <Route path="*" element={null} />
          </Routes>
          <LocationProbe />
        </ProjectContext.Provider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

const READER_PATH = `/projects/${PROJECT}/comments/${SESSION}/thread-1`;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getMessageCommentContext.mockResolvedValue(context());
  mocks.listMessageComments.mockResolvedValue({ comments: [THREAD] });
  mocks.listProjectComments.mockResolvedValue(inboxOf([THREAD]));
});

describe('comment reader', () => {
  it('opens from a Comments page row on the commented reply, with the thread', async () => {
    renderAt(`/projects/${PROJECT}/comments`);

    fireEvent.click(await screen.findByRole('button', { name: /Should this be a 409/ }));

    expect(screen.getByTestId('location')).toHaveTextContent(READER_PATH);
    await waitFor(() =>
      expect(mocks.getMessageCommentContext).toHaveBeenCalledWith(PROJECT, SESSION, 'thread-1', {
        signal: expect.any(AbortSignal),
      })
    );
    // The three chunks render as one reply, and that reply is the one marked as commented.
    const anchor = await waitFor(() => {
      const element = document.querySelector('[data-reader-anchor="true"]');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(anchor).toHaveTextContent(
      'It retries because the handler returns 500 before the idempotency check.'
    );
    expect(screen.getByRole('heading', { name: 'Webhook retries' })).toBeInTheDocument();
    expect(screen.getByText(/^The agent's reply/)).toBeInTheDocument();
    // Phone: the collapsed sheet shows who said what, so passage and comment share the screen.
    const sheet = screen.getByRole('region', { name: 'Comment thread' });
    expect(within(sheet).getByText('Grace Hopper commented')).toBeInTheDocument();
    expect(within(sheet).getByText('Should this be a 409 instead?')).toBeInTheDocument();
  });

  it('links into the chat at the thread and the commented message’s own time', async () => {
    renderAt(READER_PATH);

    const link = await screen.findByRole('link', { name: 'Open in chat' });
    await waitFor(() =>
      expect(link).toHaveAttribute(
        'href',
        `/projects/${PROJECT}/chat/${SESSION}?commentThread=thread-1&commentMessage=a2&commentAt=201`
      )
    );
  });

  it('loads earlier messages above, from the oldest loaded row', async () => {
    mocks.getMessageCommentContext.mockResolvedValue(
      context({ messages: ROWS.slice(1), hasMoreBefore: true })
    );
    mocks.listChatMessages.mockResolvedValue({ messages: [ROWS[0]], hasMore: false });
    renderAt(READER_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'Earlier messages' }));

    expect(await screen.findByText('Why does the webhook retry?')).toBeInTheDocument();
    expect(mocks.listChatMessages).toHaveBeenCalledWith(PROJECT, SESSION, {
      before: formatMessageCursor({ createdAt: 200, sequence: 200, id: 'a1' }),
      order: 'desc',
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByText('Start of the chat')).toBeInTheDocument();
    // Still the same reply is the commented one.
    expect(document.querySelector('[data-reader-anchor="true"]')).toHaveTextContent(
      'It retries because'
    );
  });

  it('loads later messages below, from the newest loaded row', async () => {
    mocks.getMessageCommentContext.mockResolvedValue(
      context({ messages: ROWS.slice(0, 4), hasMoreAfter: true })
    );
    mocks.listChatMessages.mockResolvedValue({ messages: [ROWS[4]], hasMore: false });
    renderAt(READER_PATH);

    fireEvent.click(await screen.findByRole('button', { name: 'Later messages' }));

    expect(await screen.findByText('Fix it please.')).toBeInTheDocument();
    expect(mocks.listChatMessages).toHaveBeenCalledWith(PROJECT, SESSION, {
      after: formatMessageCursor({ createdAt: 202, sequence: 202, id: 'a3' }),
      order: 'asc',
      signal: expect.any(AbortSignal),
    });
    expect(screen.getByText('Latest message')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Later messages' })).toBeNull();
    expect(document.querySelector('[data-reader-anchor="true"]')).toHaveTextContent(
      'It retries because'
    );
  });

  it('steps to the next comment in the Comments page order', async () => {
    const older = makeThread('thread-2', { createdAt: 500, body: 'Older question' });
    const resolved = makeThread('thread-3', { status: 'resolved', createdAt: 2_000 });
    mocks.listProjectComments.mockResolvedValue(inboxOf([resolved, older, THREAD]));
    renderAt(READER_PATH);

    // Needs-you comments come first, newest first; resolved ones last.
    const next = await screen.findByRole('link', { name: 'Next comment' });
    await waitFor(() =>
      expect(next).toHaveAttribute('href', `/projects/${PROJECT}/comments/${SESSION}/thread-2`)
    );
    expect(screen.getByLabelText('Previous comment')).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('1 of 3')).toBeInTheDocument();
  });

  it('links back to the previous comment from a later one', async () => {
    const older = makeThread('thread-2', { createdAt: 500, body: 'Older question' });
    mocks.listProjectComments.mockResolvedValue(inboxOf([older, THREAD]));
    mocks.getMessageCommentContext.mockResolvedValue(context({ thread: older }));
    renderAt(`/projects/${PROJECT}/comments/${SESSION}/thread-2`);

    const previous = await screen.findByRole('link', { name: 'Previous comment' });
    await waitFor(() =>
      expect(previous).toHaveAttribute('href', `/projects/${PROJECT}/comments/${SESSION}/thread-1`)
    );
    expect(screen.getByLabelText('Next comment')).toHaveAttribute('aria-disabled', 'true');
  });

  it('resolves the thread from the reader', async () => {
    // The server keeps the resolve: the list refetched after it returns the resolved thread.
    mocks.resolveMessageCommentThread.mockImplementation(async () => {
      const resolved = { ...THREAD, status: 'resolved' as const };
      mocks.listMessageComments.mockResolvedValue({ comments: [resolved] });
      return { comment: resolved };
    });
    renderAt(READER_PATH);
    fireEvent.click(await screen.findByRole('button', { name: /Show the whole thread/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Resolve' }));

    await waitFor(() =>
      expect(mocks.resolveMessageCommentThread).toHaveBeenCalledWith(PROJECT, SESSION, 'thread-1')
    );
    // As in the chat, a thread just resolved folds away behind "Show resolved thread".
    expect(await screen.findByRole('button', { name: /Show resolved thread/ })).toBeInTheDocument();
  });

  it('replies from the phone sheet and refreshes the Comments page list', async () => {
    mocks.createMessageCommentReply.mockResolvedValue({
      comment: { ...THREAD, replies: [] },
    });
    renderAt(READER_PATH);
    await screen.findByRole('region', { name: 'Comment thread' });
    const inboxLoads = mocks.listProjectComments.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'Reply…' }));
    const box = await screen.findByPlaceholderText('Reply…');
    fireEvent.change(box, { target: { value: 'Yes, 409 is right.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));

    await waitFor(() =>
      expect(mocks.createMessageCommentReply).toHaveBeenCalledWith(
        PROJECT,
        SESSION,
        'thread-1',
        expect.objectContaining({ body: 'Yes, 409 is right.', action: 'note' })
      )
    );
    await waitFor(() =>
      expect(mocks.listProjectComments.mock.calls.length).toBeGreaterThan(inboxLoads)
    );
  });

  it('offers Send to agent only to someone who can drive the chat', async () => {
    mocks.getMessageCommentContext.mockResolvedValue(context({ viewerAccess: 'reader' }));
    const reader = renderAt(READER_PATH);
    fireEvent.click(await screen.findByRole('button', { name: /Show the whole thread/ }));
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to agent' })).toBeNull();
    reader.unmount();

    // Control: the chat's owner gets it on the same thread.
    mocks.getMessageCommentContext.mockResolvedValue(context({ viewerAccess: 'owner' }));
    renderAt(READER_PATH);
    fireEvent.click(await screen.findByRole('button', { name: /Show the whole thread/ }));
    expect(await screen.findByRole('button', { name: 'Send to agent' })).toBeInTheDocument();
  });

  it('reopens a resolved thread from the reader', async () => {
    const resolved = makeThread('thread-1', { status: 'resolved' });
    mocks.listMessageComments.mockResolvedValue({ comments: [resolved] });
    mocks.getMessageCommentContext.mockResolvedValue(context({ thread: resolved }));
    mocks.reopenMessageCommentThread.mockImplementation(async () => {
      const reopened = { ...resolved, status: 'open' as const };
      mocks.listMessageComments.mockResolvedValue({ comments: [reopened] });
      return { comment: reopened };
    });
    renderAt(READER_PATH);
    fireEvent.click(await screen.findByRole('button', { name: /Show the whole thread/ }));

    // Opened on purpose, so a resolved thread shows expanded with Reopen.
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));

    await waitFor(() =>
      expect(mocks.reopenMessageCommentThread).toHaveBeenCalledWith(PROJECT, SESSION, 'thread-1')
    );
    expect(await screen.findByRole('button', { name: 'Resolve' })).toBeInTheDocument();
  });

  it('sends the comment to the agent from the reader', async () => {
    mocks.sendMessageCommentThreadToAgent.mockResolvedValue({
      comment: { ...THREAD, status: 'sent' },
    });
    renderAt(READER_PATH);
    fireEvent.click(await screen.findByRole('button', { name: /Show the whole thread/ }));

    fireEvent.click(await screen.findByRole('button', { name: 'Send to agent' }));

    await waitFor(() =>
      expect(mocks.sendMessageCommentThreadToAgent).toHaveBeenCalledWith(
        PROJECT,
        SESSION,
        'thread-1',
        expect.anything()
      )
    );
  });

  it('says so when the commented message is gone, and still shows the comment', async () => {
    mocks.getMessageCommentContext.mockResolvedValue(
      context({ anchor: { messageId: 'a2', found: false }, messages: [] })
    );
    renderAt(READER_PATH);

    expect(
      await screen.findByText('The message this comment is on is no longer in the chat.')
    ).toBeInTheDocument();
    expect(screen.getByText(/the handler returns 500/)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Comment thread' })).toBeInTheDocument();
  });

  it('says the comment is no longer available when the server answers 404', async () => {
    mocks.getMessageCommentContext.mockRejectedValue(
      new ApiClientError('NOT_FOUND', 'Comment thread not found', 404)
    );
    renderAt(READER_PATH);

    expect(await screen.findByText('This comment is no longer available.')).toBeInTheDocument();
    for (const link of screen.getAllByRole('link', { name: 'Back to comments' })) {
      expect(link).toHaveAttribute('href', `/projects/${PROJECT}/comments`);
    }
    // The session's cached comment list still has the thread; it must not offer actions on a
    // comment the page has just said is gone.
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Comment thread' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reply…' })).toBeNull();
  });

  it('offers no thread actions when the conversation fails to load', async () => {
    mocks.getMessageCommentContext.mockRejectedValue(
      new ApiClientError('INTERNAL_ERROR', 'Something went wrong on the server', 500)
    );
    renderAt(READER_PATH);

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
    await waitFor(() => expect(mocks.listMessageComments).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Comment thread' })).toBeNull();
  });

  it('opens the sheet with an upward swipe on its handle and closes it with a downward one', async () => {
    renderAt(READER_PATH);
    const handle = await screen.findByRole('button', { name: /Show the whole thread/ });

    fireEvent.touchStart(handle, { touches: [{ clientY: 600 }] });
    // A recognised swipe cancels the touch, so the browser delivers no click to undo it.
    expect(fireEvent.touchEnd(handle, { changedTouches: [{ clientY: 520 }] })).toBe(false);
    const close = await screen.findByRole('button', { name: 'Hide the thread' });
    expect(close).toHaveAttribute('aria-expanded', 'true');

    // A small movement is a tap, not a swipe, and does not close it.
    fireEvent.touchStart(close, { touches: [{ clientY: 300 }] });
    expect(fireEvent.touchEnd(close, { changedTouches: [{ clientY: 310 }] })).toBe(true);
    expect(screen.getByRole('button', { name: 'Hide the thread' })).toBeInTheDocument();

    fireEvent.touchStart(close, { touches: [{ clientY: 300 }] });
    fireEvent.touchEnd(close, { changedTouches: [{ clientY: 380 }] });
    expect(await screen.findByRole('button', { name: /Show the whole thread/ })).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('shows the thread beside the conversation on a desktop, and keeps the conversation mounted across the breakpoint', async () => {
    // A real media query list the hook subscribes to, so crossing the breakpoint is an event.
    let wide = true;
    const listeners = new Set<() => void>();
    const original = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      get matches() {
        return query.includes('1024px') ? wide : false;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      renderAt(READER_PATH);
      const aside = await screen.findByRole('complementary', { name: 'Comment thread' });
      expect(within(aside).getByText('Should this be a 409 instead?')).toBeInTheDocument();
      const scroller = document.querySelector('[data-reader-scroller]');
      const anchorRow = document.querySelector('[data-reader-anchor="true"]');
      expect(scroller).not.toBeNull();

      // Rotate to portrait: the thread moves into the sheet...
      wide = false;
      act(() => listeners.forEach((listener) => listener()));
      expect(
        await screen.findByRole('button', { name: /Show the whole thread/ })
      ).toBeInTheDocument();
      expect(screen.queryByRole('complementary', { name: 'Comment thread' })).toBeNull();
      // ...and the conversation is the same DOM, not a remount that would lose the place.
      expect(document.querySelector('[data-reader-scroller]')).toBe(scroller);
      expect(document.querySelector('[data-reader-anchor="true"]')).toBe(anchorRow);
    } finally {
      window.matchMedia = original;
    }
  });
});
