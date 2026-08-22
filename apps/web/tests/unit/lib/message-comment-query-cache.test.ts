import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import type {
  MessageCommentRealtimeEvent,
  MessageCommentThread,
} from '../../../src/lib/api/comments';
import {
  applyMessageCommentRealtimeEventToQueryCache,
  messageCommentQueryKeys,
} from '../../../src/lib/query-options';

const QUERY_SCOPE = 'user-1';
const PROJECT_ID = 'proj-1';
const SESSION_ID = 'session-1';

function makeThread(overrides: Partial<MessageCommentThread> = {}): MessageCommentThread {
  return {
    id: 'thread-1',
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    anchor: { kind: 'message', messageId: 'msg-1', quote: null },
    author: { id: 'user-1', kind: 'human', name: 'Ada' },
    body: 'Initial comment',
    createdAt: 10,
    updatedAt: 10,
    status: 'open',
    replies: [],
    ...overrides,
  };
}

function makeEvent(comment: MessageCommentThread): MessageCommentRealtimeEvent {
  return {
    type: comment.replies.length > 0 ? 'comment.reply.created' : 'comment.thread.updated',
    payload: {
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      comment,
    },
  };
}

function makeClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('message comment query cache realtime convergence', () => {
  it('upserts create, reply, resolve, and reopen events into the session cache without refetch', () => {
    const queryClient = makeClient();
    const queryKey = messageCommentQueryKeys.session(QUERY_SCOPE, PROJECT_ID, SESSION_ID);

    applyMessageCommentRealtimeEventToQueryCache(
      queryClient,
      QUERY_SCOPE,
      makeEvent(makeThread({ id: 'thread-live', body: 'Created from another browser' }))
    );

    expect(queryClient.getQueryData<MessageCommentThread[]>(queryKey)).toEqual([
      expect.objectContaining({
        id: 'thread-live',
        body: 'Created from another browser',
        status: 'open',
        replies: [],
      }),
    ]);

    applyMessageCommentRealtimeEventToQueryCache(
      queryClient,
      QUERY_SCOPE,
      makeEvent(
        makeThread({
          id: 'thread-live',
          body: 'Created from another browser',
          replies: [
            {
              id: 'reply-live',
              author: { id: 'user-2', kind: 'human', name: 'Grace' },
              body: 'Reply from another browser',
              createdAt: 20,
            },
          ],
          updatedAt: 20,
        })
      )
    );

    expect(queryClient.getQueryData<MessageCommentThread[]>(queryKey)).toEqual([
      expect.objectContaining({
        id: 'thread-live',
        replies: [
          expect.objectContaining({ id: 'reply-live', body: 'Reply from another browser' }),
        ],
      }),
    ]);

    const replies = [
      {
        id: 'reply-live',
        author: { id: 'user-2', kind: 'human' as const, name: 'Grace' },
        body: 'Reply from another browser',
        createdAt: 20,
      },
    ];

    applyMessageCommentRealtimeEventToQueryCache(
      queryClient,
      QUERY_SCOPE,
      makeEvent(makeThread({ id: 'thread-live', status: 'resolved', replies, updatedAt: 30 }))
    );

    expect(queryClient.getQueryData<MessageCommentThread[]>(queryKey)?.[0]).toMatchObject({
      id: 'thread-live',
      status: 'resolved',
      replies: [expect.objectContaining({ id: 'reply-live' })],
      updatedAt: 30,
    });

    applyMessageCommentRealtimeEventToQueryCache(
      queryClient,
      QUERY_SCOPE,
      makeEvent(makeThread({ id: 'thread-live', status: 'open', replies, updatedAt: 40 }))
    );

    expect(queryClient.getQueryData<MessageCommentThread[]>(queryKey)?.[0]).toMatchObject({
      id: 'thread-live',
      status: 'open',
      replies: [expect.objectContaining({ id: 'reply-live' })],
      updatedAt: 40,
    });
  });
});
