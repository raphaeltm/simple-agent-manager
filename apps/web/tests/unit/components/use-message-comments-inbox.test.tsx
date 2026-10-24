/**
 * A comment changed anywhere — the chat or the comment reader, both through
 * `useMessageComments` — must not leave the project Comments page showing its old state
 * until the inbox query's staleTime runs out.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listMessageComments: vi.fn(),
  resolveMessageCommentThread: vi.fn(),
  createMessageCommentReply: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listMessageComments: mocks.listMessageComments,
  resolveMessageCommentThread: mocks.resolveMessageCommentThread,
  createMessageCommentReply: mocks.createMessageCommentReply,
}));

vi.mock('../../../src/components/AuthProvider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/components/AuthProvider')>()),
  useAuth: () => ({ user: { id: 'viewer-1' }, isSuperadmin: false, isLoading: false }),
}));

import { useMessageComments } from '../../../src/components/project-message-view/comments/useMessageComments';
import type { MessageCommentThread } from '../../../src/lib/api';
import { projectCommentQueryKeys } from '../../../src/lib/query-options';

const THREAD: MessageCommentThread = {
  id: 'thread-1',
  projectId: 'proj-1',
  sessionId: 'sess-1',
  anchor: { kind: 'message', messageId: 'm1', quote: null },
  author: { id: 'someone', name: 'Someone', kind: 'human' },
  body: 'A comment',
  createdAt: 1,
  updatedAt: 1,
  status: 'open',
  replies: [],
};

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const inbox = projectCommentQueryKeys.project('viewer-1', 'proj-1');
  const otherProjectInbox = projectCommentQueryKeys.project('viewer-1', 'proj-2');
  for (const key of [inbox, otherProjectInbox]) client.setQueryData(key, { messageThreads: [] });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useMessageComments('proj-1', 'sess-1', true), { wrapper });
  return { client, inbox, otherProjectInbox, hook };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMessageComments.mockResolvedValue({ comments: [THREAD] });
});

describe('useMessageComments and the Comments page', () => {
  it('marks the project Comments page list stale after resolving a thread', async () => {
    mocks.resolveMessageCommentThread.mockResolvedValue({
      comment: { ...THREAD, status: 'resolved' },
    });
    const { client, inbox, otherProjectInbox, hook } = setup();
    await waitFor(() => expect(hook.result.current.comments).toHaveLength(1));
    expect(client.getQueryState(inbox)?.isInvalidated).toBe(false);

    await act(async () => {
      await hook.result.current.resolve('thread-1');
    });

    expect(mocks.resolveMessageCommentThread).toHaveBeenCalledWith('proj-1', 'sess-1', 'thread-1');
    expect(client.getQueryState(inbox)?.isInvalidated).toBe(true);
    // Scoped to this project: another project's list is left alone.
    expect(client.getQueryState(otherProjectInbox)?.isInvalidated).toBe(false);
  });

  it('marks it stale after a reply too, even when the request fails', async () => {
    mocks.createMessageCommentReply.mockRejectedValue(new Error('offline'));
    const { client, inbox, hook } = setup();
    await waitFor(() => expect(hook.result.current.comments).toHaveLength(1));

    await act(async () => {
      await hook.result.current
        .reply({ commentId: 'thread-1', body: 'hi', action: 'note', mentions: [] })
        .catch(() => undefined);
    });

    expect(client.getQueryState(inbox)?.isInvalidated).toBe(true);
  });
});
