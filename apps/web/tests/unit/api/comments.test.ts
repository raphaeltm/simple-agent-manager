import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createMessageCommentReply,
  createMessageCommentThread,
  listMessageComments,
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
    fetchMock.mockResolvedValueOnce(jsonResponse({ comment: { id: 'c1' } }));

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
          clientId: 'client-thread-1',
          anchor: { kind: 'message', messageId: 'msg-1', quote: 'quoted text' },
          body: 'Check this',
          action: 'send_to_agent',
        }),
      })
    );
  });

  it('routes reply and status mutations to isolated thread endpoints', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ comment: { id: 'c1' } }));

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
          clientId: 'client-reply-1',
          body: 'Reply body',
          action: 'note',
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
});
