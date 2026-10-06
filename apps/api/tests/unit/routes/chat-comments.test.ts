import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => {
  class CommentNotFoundError extends Error {
    readonly code = 'COMMENT_NOT_FOUND';
    constructor(readonly resource: 'Chat session' | 'Message' | 'Comment thread') {
      super(`${resource} not found`);
      this.name = 'CommentNotFoundError';
    }
  }

  class CommentValidationError extends Error {
    readonly code = 'COMMENT_VALIDATION';
    constructor(message: string) {
      super(message);
      this.name = 'CommentValidationError';
    }
  }

  class CommentIdempotencyConflictError extends Error {
    readonly code = 'COMMENT_IDEMPOTENCY_CONFLICT';
    constructor() {
      super('clientMutationId already belongs to a different comment mutation');
      this.name = 'CommentIdempotencyConflictError';
    }
  }

  class CommentLimitExceededError extends Error {
    readonly code = 'COMMENT_LIMIT_EXCEEDED';
    constructor(message: string) {
      super(message);
      this.name = 'CommentLimitExceededError';
    }
  }

  return {
    createCommentReply: vi.fn(),
    createCommentThread: vi.fn(),
    getMessageToolContent: vi.fn(),
    getMessages: vi.fn(),
    getSession: vi.fn(),
    listCommentThreads: vi.fn(),
    requireProjectAccess: vi.fn(),
    requireProjectCapability: vi.fn(),
    stopSession: vi.fn(),
    updateCommentThreadStatus: vi.fn(),
    CommentIdempotencyConflictError,
    CommentLimitExceededError,
    CommentNotFoundError,
    CommentValidationError,
  };
});

vi.mock('drizzle-orm/d1');
vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
  getAuth: () => ({
    user: {
      id: 'user-1',
      email: 'user@example.com',
      name: 'Ada',
      avatarUrl: null,
      role: 'user',
      status: 'active',
    },
    session: { id: 'session-1', expiresAt: new Date('2030-01-01T00:00:00Z') },
  }),
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectAccess: mocks.requireProjectAccess,
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  CommentIdempotencyConflictError: mocks.CommentIdempotencyConflictError,
  CommentLimitExceededError: mocks.CommentLimitExceededError,
  CommentNotFoundError: mocks.CommentNotFoundError,
  CommentValidationError: mocks.CommentValidationError,
  createCommentReply: mocks.createCommentReply,
  createCommentThread: mocks.createCommentThread,
  createSession: vi.fn(),
  forwardWebSocket: vi.fn(),
  getDurableExecutionSnapshot: vi.fn(),
  getMessageToolContent: mocks.getMessageToolContent,
  getMessages: mocks.getMessages,
  getSession: mocks.getSession,
  getSessionState: vi.fn(),
  linkSessionIdea: vi.fn(),
  listAcpSessions: vi.fn().mockResolvedValue({ sessions: [], total: 0 }),
  listCommentThreads: mocks.listCommentThreads,
  listSessionIdeas: vi.fn().mockResolvedValue({ ideas: [] }),
  listSessions: vi.fn(),
  prepareAttentionAnswer: vi.fn(),
  completeAttentionAnswer: vi.fn(),
  releaseAttentionAnswer: vi.fn(),
  resetIdleCleanup: vi.fn(),
  stopSession: mocks.stopSession,
  unlinkSessionIdea: vi.fn(),
  updateCommentThreadStatus: mocks.updateCommentThreadStatus,
}));
vi.mock('../../../src/services/workspace-cleanup', () => ({
  cleanupWorkspaceForDeletion: vi.fn(),
}));
vi.mock('../../../src/services/session-task-repair', () => ({
  ensureSessionTaskBacked: vi.fn(),
}));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResources: vi.fn(),
}));

import { chatRoutes } from '../../../src/routes/chat';

const thread = {
  id: 'thread-1',
  sessionId: 'session-1',
  anchor: { kind: 'message' as const, messageId: 'message-1', quote: null },
  author: { kind: 'human' as const, id: 'user-1', name: 'Ada' },
  body: 'Needs clarification',
  status: 'open' as const,
  createdAt: 1,
  updatedAt: 1,
  sequence: 1,
  version: 1,
  clientMutationId: 'mutation-1',
  sentAt: null,
  sentBy: null,
  resolvedAt: null,
  resolvedBy: null,
  reopenedAt: null,
  reopenedBy: null,
  replies: [],
};

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as never);
    }
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/sessions', chatRoutes);
  return app;
}

describe('chat comment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drizzle).mockReturnValue({} as never);
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.listCommentThreads.mockResolvedValue({ threads: [thread], hasMore: false });
    mocks.createCommentThread.mockResolvedValue({ thread, idempotent: false });
    mocks.createCommentReply.mockResolvedValue({
      thread: { ...thread, replies: [{ id: 'reply-1' }] },
      reply: { id: 'reply-1' },
      idempotent: true,
    });
    mocks.updateCommentThreadStatus.mockResolvedValue({
      thread: { ...thread, status: 'resolved' },
      idempotent: false,
    });
  });

  it('lists comment threads with task:read project authorization and bounded query params', async () => {
    const response = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments?messageId=message-1&status=open&afterSequence=3&limit=10',
      { method: 'GET' },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(200);
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'user-1',
      'task:read'
    );
    expect(mocks.listCommentThreads).toHaveBeenCalledWith(expect.anything(), 'project-1', {
      sessionId: 'session-1',
      messageId: 'message-1',
      status: 'open',
      afterSequence: 3,
      limit: 10,
    });
  });

  it('creates threads and replies with human actor and clientMutationId payloads', async () => {
    const createResponse = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageId: 'message-1',
          body: 'Needs clarification',
          clientMutationId: 'thread-key',
        }),
      },
      { DATABASE: {} } as Env
    );
    expect(createResponse.status).toBe(201);
    expect(mocks.requireProjectCapability).toHaveBeenLastCalledWith(
      expect.anything(),
      'project-1',
      'user-1',
      'task:write'
    );
    expect(mocks.createCommentThread).toHaveBeenCalledWith(expect.anything(), 'project-1', {
      sessionId: 'session-1',
      messageId: 'message-1',
      body: 'Needs clarification',
      quote: null,
      clientMutationId: 'thread-key',
      actor: { kind: 'human', id: 'user-1', name: 'Ada' },
    });

    const replyResponse = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments/thread-1/replies',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Reply', clientMutationId: 'reply-key' }),
      },
      { DATABASE: {} } as Env
    );
    expect(replyResponse.status).toBe(200);
    expect(mocks.createCommentReply).toHaveBeenCalledWith(expect.anything(), 'project-1', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      body: 'Reply',
      clientMutationId: 'reply-key',
      actor: { kind: 'human', id: 'user-1', name: 'Ada' },
    });
  });

  it('updates status through server-authoritative transition endpoints', async () => {
    const response = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments/thread-1/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMutationId: 'resolve-key' }),
      },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(200);
    expect(mocks.updateCommentThreadStatus).toHaveBeenCalledWith(expect.anything(), 'project-1', {
      sessionId: 'session-1',
      threadId: 'thread-1',
      status: 'resolved',
      clientMutationId: 'resolve-key',
      actor: { kind: 'human', id: 'user-1', name: 'Ada' },
    });
  });

  it('does not reach ProjectData when project authorization rejects membership', async () => {
    mocks.requireProjectCapability.mockRejectedValueOnce(
      new AppError(404, 'NOT_FOUND', 'Project not found')
    );

    const response = await createApp().request(
      'https://api.test/api/projects/project-2/sessions/session-1/comments',
      { method: 'GET' },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(404);
    expect(mocks.listCommentThreads).not.toHaveBeenCalled();
  });

  it('maps ProjectData validation, missing-message, and idempotency errors to API errors', async () => {
    const invalidStatus = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments?status=closed',
      { method: 'GET' },
      { DATABASE: {} } as Env
    );
    expect(invalidStatus.status).toBe(400);

    mocks.createCommentThread.mockRejectedValueOnce(new mocks.CommentNotFoundError('Message'));
    const missingMessage = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: 'missing-message', body: 'Thread' }),
      },
      { DATABASE: {} } as Env
    );
    expect(missingMessage.status).toBe(404);
    await expect(missingMessage.json()).resolves.toMatchObject({ message: 'Message not found' });

    mocks.createCommentReply.mockRejectedValueOnce(new mocks.CommentIdempotencyConflictError());
    const conflict = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-1/comments/thread-1/replies',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'Reply', clientMutationId: 'used-key' }),
      },
      { DATABASE: {} } as Env
    );
    expect(conflict.status).toBe(409);
  });

  it('maps serialized cross-session comment mutation misses to clean 404 errors', async () => {
    mocks.updateCommentThreadStatus.mockRejectedValueOnce(new Error('Comment thread not found'));

    const response = await createApp().request(
      'https://api.test/api/projects/project-1/sessions/session-other/comments/thread-1/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientMutationId: 'cross-session-resolve' }),
      },
      { DATABASE: {} } as Env
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: 'NOT_FOUND',
      message: 'Comment thread not found',
    });
  });
});
