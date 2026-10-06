/**
 * Behavioral tests for the library file comment panel.
 *
 * These render the real component and simulate the real user interactions —
 * typing a comment, submitting it, replying, resolving, reopening — and assert
 * the user-visible outcome plus the exact payload that reached the API client.
 * Only the API client module is mocked (the network boundary).
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  LibraryFileCommentThread,
  MessageCommentAuthor,
} from '../../../src/lib/api/comments';

const api = vi.hoisted(() => ({
  listLibraryFileComments: vi.fn(),
  createLibraryFileCommentThread: vi.fn(),
  replyToLibraryFileComment: vi.fn(),
  resolveLibraryFileComment: vi.fn(),
  reopenLibraryFileComment: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async () => {
  const actual = await vi.importActual<typeof import('../../../src/lib/api/comments')>(
    '../../../src/lib/api/comments'
  );
  return { ...actual, ...api };
});

vi.mock('../../../src/components/AuthProvider', () => ({
  useAuth: () => ({
    user: {
      id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      avatarUrl: null,
    },
  }),
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

// The voice button reaches for media APIs jsdom does not implement; the comment
// flow under test does not involve dictation.
vi.mock('@simple-agent-manager/acp-client', () => ({
  VoiceButton: () => null,
  appendDictatedText: (current: string, text: string) =>
    current ? `${current} ${text}` : text,
}));

import { FileCommentPanel } from '../../../src/components/library/FileCommentPanel';

const PROJECT_ID = 'project-1';
const FILE_ID = 'file-1';

const author: MessageCommentAuthor = {
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  avatarUrl: null,
  kind: 'human',
};

function makeThread(overrides: Partial<LibraryFileCommentThread> = {}): LibraryFileCommentThread {
  return {
    id: 'thread-1',
    clientId: null,
    projectId: PROJECT_ID,
    fileId: FILE_ID,
    anchor: { kind: 'library_file', fileId: FILE_ID, quote: null },
    author,
    body: 'The second paragraph contradicts the first.',
    createdAt: Date.now() - 60_000,
    updatedAt: Date.now() - 60_000,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof FileCommentPanel>> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  return render(
    <FileCommentPanel
      projectId={PROJECT_ID}
      fileId={FILE_ID}
      onClose={props.onClose ?? vi.fn()}
      {...props}
    />,
    { wrapper }
  );
}

describe('FileCommentPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.listLibraryFileComments.mockResolvedValue({ threads: [], hasMore: false });
  });

  it('renders existing threads for the file', async () => {
    api.listLibraryFileComments.mockResolvedValue({
      threads: [makeThread({ body: 'Needs a source citation.' })],
      hasMore: false,
    });

    renderPanel();

    expect(await screen.findByText('Needs a source citation.')).toBeInTheDocument();
  });

  it('shows an empty state rather than a blank panel when there are no comments', async () => {
    renderPanel();

    expect(await screen.findByText('No comments on this file yet.')).toBeInTheDocument();
  });

  it('creates a thread with the typed body when the user submits', async () => {
    // The server echoes the clientMutationId back as the thread's clientId —
    // that echo is what lets the cache retire the optimistic row.
    api.createLibraryFileCommentThread.mockImplementation(
      async (_projectId: string, _fileId: string, input: { clientMutationId: string }) => ({
        thread: makeThread({
          id: 'thread-new',
          body: 'This heading is wrong.',
          clientId: input.clientMutationId,
        }),
        idempotent: false,
      })
    );

    renderPanel();
    await screen.findByText('No comments on this file yet.');

    fireEvent.change(screen.getByPlaceholderText('Add a comment on this file…'), {
      target: { value: 'This heading is wrong.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => {
      expect(api.createLibraryFileCommentThread).toHaveBeenCalledWith(PROJECT_ID, FILE_ID, {
        body: 'This heading is wrong.',
        quote: undefined,
        clientMutationId: expect.any(String),
      });
    });
    // Exactly one — the optimistic row must be replaced, not duplicated.
    await waitFor(() => {
      expect(screen.getAllByText('This heading is wrong.')).toHaveLength(1);
    });
  });

  it('attaches the selected quote to the thread it creates', async () => {
    api.createLibraryFileCommentThread.mockImplementation(
      async (_projectId: string, _fileId: string, input: { clientMutationId: string }) => ({
        thread: makeThread({
          id: 'thread-quoted',
          body: 'Contradicts the intro.',
          clientId: input.clientMutationId,
          anchor: { kind: 'library_file', fileId: FILE_ID, quote: 'the quick brown fox' },
        }),
        idempotent: false,
      })
    );
    const onClearPendingQuote = vi.fn();

    renderPanel({ pendingQuote: 'the quick brown fox', onClearPendingQuote });
    await screen.findByText('No comments on this file yet.');

    // The pending selection is shown to the user before they commit to it.
    expect(screen.getByText('the quick brown fox')).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Comment on the selected text…'), {
      target: { value: 'Contradicts the intro.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    await waitFor(() => {
      expect(api.createLibraryFileCommentThread).toHaveBeenCalledWith(PROJECT_ID, FILE_ID, {
        body: 'Contradicts the intro.',
        quote: 'the quick brown fox',
        clientMutationId: expect.any(String),
      });
    });
    expect(onClearPendingQuote).toHaveBeenCalled();
  });

  it('cancelling a quoted draft drops the quote instead of closing the panel', async () => {
    const onClearPendingQuote = vi.fn();
    const onClose = vi.fn();

    renderPanel({ pendingQuote: 'the quick brown fox', onClearPendingQuote, onClose });
    await screen.findByText('No comments on this file yet.');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClearPendingQuote).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('replies to an existing thread', async () => {
    const thread = makeThread();
    api.listLibraryFileComments.mockResolvedValue({ threads: [thread], hasMore: false });
    api.replyToLibraryFileComment.mockResolvedValue({
      thread: {
        ...thread,
        replies: [
          {
            id: 'reply-1',
            clientId: null,
            author,
            body: 'Good catch — fixing.',
            createdAt: Date.now(),
            updatedAt: null,
            sentToAgent: false,
          },
        ],
      },
      idempotent: false,
    });

    renderPanel();
    await screen.findByText(thread.body);

    fireEvent.click(screen.getByRole('button', { name: 'Reply' }));
    fireEvent.change(screen.getByPlaceholderText('Reply…'), {
      target: { value: 'Good catch — fixing.' },
    });
    const composer = screen.getByPlaceholderText('Reply…').closest('form');
    fireEvent.click(within(composer as HTMLElement).getByRole('button', { name: 'Reply' }));

    await waitFor(() => {
      expect(api.replyToLibraryFileComment).toHaveBeenCalledWith(
        PROJECT_ID,
        FILE_ID,
        thread.id,
        expect.objectContaining({ body: 'Good catch — fixing.' })
      );
    });
    expect(await screen.findByText('Good catch — fixing.')).toBeInTheDocument();
  });

  it('resolves and then reopens a thread', async () => {
    const thread = makeThread();
    api.listLibraryFileComments.mockResolvedValue({ threads: [thread], hasMore: false });
    api.resolveLibraryFileComment.mockResolvedValue({
      thread: { ...thread, status: 'resolved' },
      idempotent: false,
    });
    api.reopenLibraryFileComment.mockResolvedValue({ thread, idempotent: false });

    renderPanel();
    await screen.findByText(thread.body);

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    await waitFor(() => {
      expect(api.resolveLibraryFileComment).toHaveBeenCalledWith(PROJECT_ID, FILE_ID, thread.id);
    });

    // A resolved thread collapses; the user has to expand it to act on it again.
    fireEvent.click(await screen.findByRole('button', { name: /Show resolved thread/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reopen' }));
    await waitFor(() => {
      expect(api.reopenLibraryFileComment).toHaveBeenCalledWith(PROJECT_ID, FILE_ID, thread.id);
    });
  });

  it('never offers send-to-agent — file comments have no agent directive in Phase 1', async () => {
    api.listLibraryFileComments.mockResolvedValue({
      threads: [makeThread()],
      hasMore: false,
    });

    renderPanel();
    await screen.findByText('The second paragraph contradicts the first.');

    expect(screen.queryByRole('button', { name: 'Send to agent' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Comment action')).not.toBeInTheDocument();
  });

  it('surfaces a load failure instead of an empty state', async () => {
    api.listLibraryFileComments.mockRejectedValue(new Error('Library file not found'));

    renderPanel();

    expect(await screen.findByText('Library file not found')).toBeInTheDocument();
    expect(screen.queryByText('No comments on this file yet.')).not.toBeInTheDocument();
  });

  it('rolls the optimistic thread back and tells the user when the create fails', async () => {
    api.createLibraryFileCommentThread.mockRejectedValue(
      new Error('Comment thread limit reached')
    );

    renderPanel();
    await screen.findByText('No comments on this file yet.');

    const composer = screen.getByPlaceholderText('Add a comment on this file…');
    fireEvent.change(composer, { target: { value: 'Will not stick.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));

    // The failure is reported rather than silently swallowed...
    expect(await screen.findByRole('alert')).toHaveTextContent('Comment thread limit reached');
    // ...the optimistic thread is gone...
    await waitFor(() => {
      expect(screen.getByText('No comments on this file yet.')).toBeInTheDocument();
    });
    // ...and the draft survives so the user can retry without retyping.
    expect(composer).toHaveValue('Will not stick.');
  });
});
