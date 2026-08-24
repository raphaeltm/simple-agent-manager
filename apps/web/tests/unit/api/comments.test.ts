import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageCommentReply,
  createMessageCommentThread,
  listMessageComments,
  listProjectComments,
  reopenMessageCommentThread,
  resolveMessageCommentThread,
  sendMessageCommentThreadToAgent,
} from '../../../src/lib/api/comments';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  });
}

function backendThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    sessionId: 'sess-1',
    anchor: { kind: 'message', messageId: 'msg-1', quote: 'quoted text' },
    author: { kind: 'human', id: 'user-1', name: 'Ada' },
    body: 'Check this',
    createdAt: 1,
    updatedAt: 1,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

function backendFileThread(overrides: Record<string, unknown> = {}) {
  return {
    id: 'fc1',
    fileId: 'file-1',
    anchor: { kind: 'library_file', fileId: 'file-1', quote: 'file quote' },
    author: { kind: 'agent', id: 'agent-1', displayName: 'SAM' },
    body: 'File comment',
    createdAt: 2,
    updatedAt: 3,
    status: 'resolved',
    replies: [],
    ...overrides,
  };
}

describe('message comment API client', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockImplementation(async () => jsonResponse({ comments: [] }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists message-anchored comments with the documented anchor filter', async () => {
    await listMessageComments('proj-1', 'sess-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments?anchorKind=message',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
  });

  it('creates a thread with client id, message anchor, body, and explicit action', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ thread: backendThread() }))
      .mockResolvedValueOnce(jsonResponse({ thread: backendThread({ status: 'sent' }) }));

    await createMessageCommentThread('proj-1', 'sess-1', {
      clientId: 'client-thread-1',
      anchor: { kind: 'message', messageId: 'msg-1', quote: 'quoted text' },
      body: 'Check this',
      action: 'send_to_agent',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messageId: 'msg-1',
          quote: 'quoted text',
          body: 'Check this',
          clientMutationId: 'client-thread-1',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments/c1/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'Check this' }),
      })
    );
  });

  it('routes reply and status mutations to isolated thread endpoints', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ thread: backendThread() }));

    await createMessageCommentReply('proj-1', 'sess-1', 'c1', {
      clientId: 'client-reply-1',
      body: 'Reply body',
      action: 'note',
    });
    await resolveMessageCommentThread('proj-1', 'sess-1', 'c1');
    await reopenMessageCommentThread('proj-1', 'sess-1', 'c1');
    await sendMessageCommentThreadToAgent('proj-1', 'sess-1', 'c1', { body: 'Send context' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments/c1/replies',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          body: 'Reply body',
          clientMutationId: 'client-reply-1',
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments/c1/resolve',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments/c1/reopen',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      'http://localhost:8787/api/projects/proj-1/sessions/sess-1/comments/c1/send',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ body: 'Send context' }),
      })
    );
  });

  it('maps project-wide comments and reference labels from the single endpoint', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        messageThreads: [
          backendThread({
            id: 'mc1',
            clientMutationId: 'client-message-thread',
            author: { kind: 'human', id: 'user-1', displayName: 'Ada Display' },
            replies: [
              {
                id: 'mr1',
                clientMutationId: 'client-message-reply',
                author: { kind: 'agent', id: 'agent-1', name: 'SAM' },
                body: 'Message reply',
                createdAt: 4,
                sentToAgent: true,
              },
            ],
          }),
        ],
        fileThreads: [
          backendFileThread({
            id: 'fc1',
            clientMutationId: 'client-file-thread',
            replies: [
              {
                id: 'fr1',
                author: { kind: 'human', id: 'user-2', name: 'Grace' },
                body: 'File reply',
                createdAt: 5,
              },
            ],
          }),
        ],
        sessions: [{ id: 'sess-1', topic: null }],
        files: [{ id: 'file-1', filename: 'notes.md' }],
        hasMore: true,
        totalCount: 9,
      })
    );

    const result = await listProjectComments('proj-1', { status: 'open', limit: 2 });

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:8787/api/projects/proj-1/comments?status=open&limit=2',
      expect.objectContaining({
        credentials: 'include',
        headers: expect.objectContaining({ 'Content-Type': 'application/json' }),
      })
    );
    expect(result.messageThreads[0]).toMatchObject({
      id: 'mc1',
      clientId: 'client-message-thread',
      projectId: 'proj-1',
      author: { name: 'Ada Display' },
      replies: [
        {
          id: 'mr1',
          clientId: 'client-message-reply',
          sentToAgent: true,
        },
      ],
    });
    expect(result.fileThreads[0]).toMatchObject({
      id: 'fc1',
      clientId: 'client-file-thread',
      fileId: 'file-1',
      author: { name: 'SAM' },
      replies: [{ id: 'fr1', sentToAgent: false }],
    });
    expect(result.sessionTopics.get('sess-1')).toBeNull();
    expect(result.fileNames.get('file-1')).toBe('notes.md');
    expect(result.hasMore).toBe(true);
    expect(result.totalCount).toBe(9);
  });

  it('falls back to returned thread count when project-wide total is omitted', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        messageThreads: [backendThread()],
        fileThreads: [backendFileThread()],
      })
    );

    const result = await listProjectComments('proj-1');

    expect(result.totalCount).toBe(2);
    expect(result.hasMore).toBe(false);
  });
});
