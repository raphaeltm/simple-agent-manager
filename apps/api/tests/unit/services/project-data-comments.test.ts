import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import * as svc from '../../../src/services/project-data';
import { resetProjectDataEnsureMemo } from '../../../src/services/project-data-ensure-memo';

const actor = { kind: 'human' as const, id: 'user-1', name: 'Ada' };
const thread = {
  id: 'thread-1',
  sessionId: 'session-1',
  anchor: { kind: 'message' as const, messageId: 'message-1', quote: null },
  author: actor,
  body: 'Needs clarification',
  status: 'open' as const,
  createdAt: 1,
  updatedAt: 1,
  sequence: 1,
  version: 1,
  clientMutationId: 'thread-key',
  sentAt: null,
  sentBy: null,
  resolvedAt: null,
  resolvedBy: null,
  reopenedAt: null,
  reopenedBy: null,
  replies: [],
};

function makeEnv(stub: Record<string, unknown>): Env {
  return {
    DO_RETRY_MAX_ATTEMPTS: '2',
    DO_RETRY_BASE_DELAY_MS: '1',
    PROJECT_DATA: {
      idFromName: vi.fn((name: string) => ({ toString: () => `doid-${name}` })),
      get: vi.fn(() => stub),
    },
  } as unknown as Env;
}

beforeEach(() => {
  resetProjectDataEnsureMemo();
});

describe('project-data service comment RPC wrappers', () => {
  it('forwards list, create, reply, and status inputs to the ProjectData stub', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      listCommentThreads: vi.fn().mockResolvedValue({ threads: [thread], hasMore: false }),
      createCommentThread: vi.fn().mockResolvedValue({ thread, idempotent: false }),
      createCommentReply: vi.fn().mockResolvedValue({
        thread: { ...thread, replies: [{ id: 'reply-1' }] },
        reply: { id: 'reply-1' },
        idempotent: false,
      }),
      updateCommentThreadStatus: vi.fn().mockResolvedValue({
        thread: { ...thread, status: 'resolved' },
        idempotent: false,
      }),
    };
    const env = makeEnv(stub);

    await expect(
      svc.listCommentThreads(env, 'project-1', {
        sessionId: 'session-1',
        messageId: 'message-1',
        status: 'open',
        afterSequence: 2,
        limit: 10,
      })
    ).resolves.toMatchObject({ threads: [thread], hasMore: false });

    await expect(
      svc.createCommentThread(env, 'project-1', {
        sessionId: 'session-1',
        messageId: 'message-1',
        body: 'Needs clarification',
        quote: null,
        clientMutationId: 'thread-key',
        actor,
      })
    ).resolves.toMatchObject({ thread, idempotent: false });

    await expect(
      svc.createCommentReply(env, 'project-1', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        body: 'Reply',
        clientMutationId: 'reply-key',
        actor,
      })
    ).resolves.toMatchObject({ reply: { id: 'reply-1' }, idempotent: false });

    await expect(
      svc.updateCommentThreadStatus(env, 'project-1', {
        sessionId: 'session-1',
        threadId: 'thread-1',
        status: 'resolved',
        clientMutationId: 'resolve-key',
        actor,
      })
    ).resolves.toMatchObject({ thread: { status: 'resolved' }, idempotent: false });

    expect(stub.listCommentThreads).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: 'message-1',
      status: 'open',
      afterSequence: 2,
      limit: 10,
    });
    expect(stub.createCommentThread).toHaveBeenCalledWith({
      sessionId: 'session-1',
      messageId: 'message-1',
      body: 'Needs clarification',
      quote: null,
      clientMutationId: 'thread-key',
      actor,
    });
    expect(stub.createCommentReply).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
      body: 'Reply',
      clientMutationId: 'reply-key',
      actor,
    });
    expect(stub.updateCommentThreadStatus).toHaveBeenCalledWith({
      sessionId: 'session-1',
      threadId: 'thread-1',
      status: 'resolved',
      clientMutationId: 'resolve-key',
      actor,
    });
  });

  it('normalizes exact serialized DO comment not-found errors at the RPC boundary', async () => {
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      updateCommentThreadStatus: vi
        .fn()
        .mockRejectedValue(new Error('CommentNotFoundError: Comment thread not found')),
    };
    const env = makeEnv(stub);

    await expect(
      svc.updateCommentThreadStatus(env, 'project-1', {
        sessionId: 'session-other',
        threadId: 'thread-1',
        status: 'resolved',
        clientMutationId: 'resolve-key',
        actor,
      })
    ).rejects.toMatchObject({
      name: 'CommentNotFoundError',
      code: 'COMMENT_NOT_FOUND',
      resource: 'Comment thread',
      message: 'Comment thread not found',
    });
  });

  it('does not normalize non-exact serialized-looking internal errors', async () => {
    const internal = new Error('CommentNotFoundError: database unavailable');
    const stub = {
      ensureProjectId: vi.fn().mockResolvedValue(undefined),
      updateCommentThreadStatus: vi.fn().mockRejectedValue(internal),
    };
    const env = makeEnv(stub);

    await expect(
      svc.updateCommentThreadStatus(env, 'project-1', {
        sessionId: 'session-other',
        threadId: 'thread-1',
        status: 'resolved',
        clientMutationId: 'resolve-key',
        actor,
      })
    ).rejects.toBe(internal);
  });
});
