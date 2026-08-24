/**
 * The project comment inbox hook.
 *
 * The load-bearing assertion here is the request COUNT. This hook used to
 * assemble the page with a client-side join: one request per recent chat session
 * plus one per library file, up to 52 per page load. Raphaël rejected that on
 * review ("This isn't acceptable if we build for real. We'd have to just build
 * the endpoint."), so a test that only checked the rendered items would pass
 * equally well against the thing that was removed.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listProjectComments: vi.fn(),
  listMessageComments: vi.fn(),
  listLibraryFileComments: vi.fn(),
  listChatSessions: vi.fn(),
  listLibraryFiles: vi.fn(),
}));

vi.mock('../../../src/lib/api/comments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api/comments')>()),
  listProjectComments: mocks.listProjectComments,
  listMessageComments: mocks.listMessageComments,
  listLibraryFileComments: mocks.listLibraryFileComments,
}));

vi.mock('../../../src/hooks/useQueryScope', () => ({
  useQueryScope: () => 'user-1',
}));

import { useProjectCommentInbox } from '../../../src/components/project-message-view/comments/useProjectCommentInbox';

function messageThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-msg-1',
    clientId: null,
    projectId: 'project-1',
    sessionId: 'session-1',
    anchor: { kind: 'message' as const, messageId: 'message-1', quote: 'quoted text' },
    author: { id: 'user-2', kind: 'human' as const, name: 'Grace', email: null, avatarUrl: null },
    body: 'a message comment',
    createdAt: 1_000,
    updatedAt: 1_000,
    status: 'open' as const,
    replies: [],
    ...overrides,
  };
}

function fileThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'thread-file-1',
    clientId: null,
    projectId: 'project-1',
    fileId: 'file-1',
    anchor: { kind: 'library_file' as const, fileId: 'file-1', quote: null },
    author: { id: 'user-2', kind: 'human' as const, name: 'Grace', email: null, avatarUrl: null },
    body: 'a file comment',
    createdAt: 2_000,
    updatedAt: 2_000,
    status: 'open' as const,
    replies: [],
    ...overrides,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    messageThreads: [messageThread()],
    fileThreads: [fileThread()],
    sessionTopics: new Map([['session-1', 'Ship the inbox']]),
    fileNames: new Map([['file-1', 'design-notes.md']]),
    hasMore: false,
    totalCount: 2,
    ...overrides,
  };
}

function createWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

async function renderInbox() {
  const rendered = renderHook(() => useProjectCommentInbox('project-1'), {
    wrapper: createWrapper(),
  });
  await waitFor(() => expect(rendered.result.current.loading).toBe(false));
  return rendered;
}

describe('useProjectCommentInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listProjectComments.mockResolvedValue(response());
  });

  it('issues exactly one request — no per-session or per-file fan-out', async () => {
    await renderInbox();

    expect(mocks.listProjectComments).toHaveBeenCalledTimes(1);
    expect(mocks.listProjectComments).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ signal: expect.anything() })
    );
    // The fan-out this hook replaced.
    expect(mocks.listMessageComments).not.toHaveBeenCalled();
    expect(mocks.listLibraryFileComments).not.toHaveBeenCalled();
  });

  it('does not add requests as the project accumulates sessions and files', async () => {
    mocks.listProjectComments.mockResolvedValue(
      response({
        messageThreads: Array.from({ length: 30 }, (_, i) =>
          messageThread({ id: `thread-msg-${i}`, sessionId: `session-${i}` })
        ),
        fileThreads: Array.from({ length: 20 }, (_, i) =>
          fileThread({ id: `thread-file-${i}`, fileId: `file-${i}` })
        ),
        sessionTopics: new Map(
          Array.from({ length: 30 }, (_, i) => [`session-${i}`, `Chat ${i}`] as const)
        ),
        fileNames: new Map(
          Array.from({ length: 20 }, (_, i) => [`file-${i}`, `f${i}.md`] as const)
        ),
        totalCount: 50,
      })
    );

    const { result } = await renderInbox();

    expect(result.current.items).toHaveLength(50);
    // 50 threads across 30 sessions and 20 files — still one request.
    expect(mocks.listProjectComments).toHaveBeenCalledTimes(1);
  });

  it('labels each item with where it lives', async () => {
    const { result } = await renderInbox();

    const sources = result.current.items.map((item) => item.source);
    expect(sources).toContainEqual({
      kind: 'session',
      sessionId: 'session-1',
      sessionTopic: 'Ship the inbox',
      messageId: 'message-1',
    });
    expect(sources).toContainEqual({
      kind: 'library_file',
      fileId: 'file-1',
      fileName: 'design-notes.md',
    });
  });

  it('falls back to a placeholder topic when a session has none', async () => {
    mocks.listProjectComments.mockResolvedValue(
      response({ sessionTopics: new Map([['session-1', null]]) })
    );

    const { result } = await renderInbox();
    const source = result.current.items.find((item) => item.source.kind === 'session')?.source;

    expect(source).toMatchObject({ sessionTopic: 'Untitled chat' });
  });

  /**
   * A thread outlives its file: the thread row is in the Durable Object, the
   * filename is in D1. Dropping the thread would silently hide a real comment.
   */
  it('keeps a thread whose file was deleted, labelled rather than dropped', async () => {
    mocks.listProjectComments.mockResolvedValue(response({ fileNames: new Map() }));

    const { result } = await renderInbox();
    const source = result.current.items.find((item) => item.source.kind === 'library_file')?.source;

    expect(result.current.items).toHaveLength(2);
    expect(source).toMatchObject({ fileId: 'file-1', fileName: 'Deleted file' });
  });

  it('surfaces truncation so the page can disclose the cut', async () => {
    mocks.listProjectComments.mockResolvedValue(response({ hasMore: true, totalCount: 137 }));

    const { result } = await renderInbox();

    expect(result.current.truncated).toBe(true);
    expect(result.current.shownCount).toBe(2);
    expect(result.current.totalCount).toBe(137);
  });

  it('reports no truncation when the page covers everything', async () => {
    const { result } = await renderInbox();

    expect(result.current.truncated).toBe(false);
    expect(result.current.shownCount).toBe(2);
    expect(result.current.totalCount).toBe(2);
  });

  it('derives last activity from the newest reply, not the thread body', async () => {
    mocks.listProjectComments.mockResolvedValue(
      response({
        messageThreads: [
          messageThread({
            replies: [
              {
                id: 'reply-1',
                clientId: null,
                author: {
                  id: 'agent-1',
                  kind: 'agent' as const,
                  name: 'SAM',
                  email: null,
                  avatarUrl: null,
                },
                body: 'agent replied',
                createdAt: 9_000,
                updatedAt: null,
                sentToAgent: false,
              },
            ],
          }),
        ],
        fileThreads: [],
        totalCount: 1,
      })
    );

    const { result } = await renderInbox();
    const item = result.current.items[0];

    expect(item?.lastActivityAt).toBe(9_000);
    expect(item?.lastActor.id).toBe('agent-1');
    expect(item?.messageCount).toBe(2);
  });

  it('returns an empty inbox without requesting anything when there is no project', async () => {
    const { result } = renderHook(() => useProjectCommentInbox(''), { wrapper: createWrapper() });

    expect(result.current.items).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(mocks.listProjectComments).not.toHaveBeenCalled();
  });
});
