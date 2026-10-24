/**
 * HTTP route tests for library file comments.
 *
 * Mocks only at the system boundaries the routes actually cross — D1 (via the
 * drizzle query used by assertLibraryFileInProject), the project-auth middleware,
 * and the ProjectData service. Everything between the request and those
 * boundaries is the real code path.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';

const mocks = vi.hoisted(() => {
  class CommentNotFoundError extends Error {
    readonly code = 'COMMENT_NOT_FOUND';
    constructor(
      readonly resource: 'Chat session' | 'Message' | 'Comment thread' | 'Library file'
    ) {
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
    findFirst: vi.fn(),
    requireProjectCapability: vi.fn(),
    listFileCommentThreads: vi.fn(),
    createFileCommentThread: vi.fn(),
    createFileCommentReply: vi.fn(),
    updateFileCommentThreadStatus: vi.fn(),
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
  requireProjectAccess: vi.fn(),
  requireProjectCapability: mocks.requireProjectCapability,
}));
vi.mock('../../../src/services/project-data', () => ({
  CommentIdempotencyConflictError: mocks.CommentIdempotencyConflictError,
  CommentLimitExceededError: mocks.CommentLimitExceededError,
  CommentNotFoundError: mocks.CommentNotFoundError,
  CommentValidationError: mocks.CommentValidationError,
  listFileCommentThreads: mocks.listFileCommentThreads,
  createFileCommentThread: mocks.createFileCommentThread,
  createFileCommentReply: mocks.createFileCommentReply,
  updateFileCommentThreadStatus: mocks.updateFileCommentThreadStatus,
}));

import { libraryCommentRoutes } from '../../../src/routes/library-comments';

const FILE_ID = 'file-1';
const THREAD_ID = 'thread-1';

const thread = {
  id: THREAD_ID,
  fileId: FILE_ID,
  anchor: { kind: 'library_file' as const, fileId: FILE_ID, quote: null },
  author: { kind: 'human' as const, id: 'user-1', name: 'Ada' },
  body: 'Needs clarification',
  status: 'open' as const,
  createdAt: 1,
  updatedAt: 1,
  sequence: 1,
  version: 1,
  clientMutationId: null,
  resolvedAt: null,
  resolvedBy: null,
  reopenedAt: null,
  reopenedBy: null,
  replies: [],
};

function createApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) return c.json(err.toJSON(), err.statusCode as never);
    return c.json({ error: 'INTERNAL_ERROR', message: err.message }, 500);
  });
  app.route('/api/projects/:projectId/library', libraryCommentRoutes);
  return app;
}

function request(path: string, init?: RequestInit) {
  return createApp().request(`https://api.test${path}`, init, { DATABASE: {} } as Env);
}

function jsonPost(path: string, body: unknown) {
  return request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BASE = `/api/projects/project-1/library/${FILE_ID}/comments`;

describe('library file comment routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(drizzle).mockReturnValue({
      query: { projectFiles: { findFirst: mocks.findFirst } },
    } as never);
    mocks.findFirst.mockResolvedValue({ id: FILE_ID });
    mocks.requireProjectCapability.mockResolvedValue({ id: 'project-1' });
    mocks.listFileCommentThreads.mockResolvedValue({ threads: [thread], hasMore: false });
    mocks.createFileCommentThread.mockResolvedValue({ thread, idempotent: false });
    mocks.createFileCommentReply.mockResolvedValue({
      thread: { ...thread, replies: [{ id: 'reply-1' }] },
      reply: { id: 'reply-1' },
      idempotent: false,
    });
    mocks.updateFileCommentThreadStatus.mockResolvedValue({
      thread: { ...thread, status: 'resolved' },
      idempotent: false,
    });
  });

  describe('GET /:fileId/comments', () => {
    it('lists threads under task:read with bounded query params', async () => {
      const response = await request(`${BASE}?status=open&afterSequence=3&limit=10`);

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ threads: [thread], hasMore: false });
      expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'user-1',
        'task:read'
      );
      expect(mocks.listFileCommentThreads).toHaveBeenCalledWith(expect.anything(), 'project-1', {
        fileId: FILE_ID,
        status: 'open',
        afterSequence: 3,
        limit: 10,
      });
    });

    it('rejects a non-numeric limit before reaching the durable object', async () => {
      const response = await request(`${BASE}?limit=abc`);

      expect(response.status).toBe(400);
      expect(mocks.listFileCommentThreads).not.toHaveBeenCalled();
    });

    it('rejects an unknown status before reaching the durable object', async () => {
      const response = await request(`${BASE}?status=archived`);

      expect(response.status).toBe(400);
      expect(mocks.listFileCommentThreads).not.toHaveBeenCalled();
    });
  });

  describe('POST /:fileId/comments', () => {
    it('creates a thread under task:write and returns 201', async () => {
      const response = await jsonPost(BASE, {
        body: 'Needs clarification',
        quote: 'the selected text',
        clientMutationId: 'mutation-1',
      });

      expect(response.status).toBe(201);
      expect(mocks.requireProjectCapability).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        'user-1',
        'task:write'
      );
      expect(mocks.createFileCommentThread).toHaveBeenCalledWith(expect.anything(), 'project-1', {
        fileId: FILE_ID,
        body: 'Needs clarification',
        quote: 'the selected text',
        clientMutationId: 'mutation-1',
        actor: { kind: 'human', id: 'user-1', name: 'Ada' },
      });
    });

    it('returns 200 rather than 201 when the write was an idempotent replay', async () => {
      mocks.createFileCommentThread.mockResolvedValue({ thread, idempotent: true });

      const response = await jsonPost(BASE, { body: 'Needs clarification' });

      expect(response.status).toBe(200);
    });

    it('rejects a whitespace-only body with 400', async () => {
      // Body length/emptiness is validated once, in the durable object's shared
      // normalizeBody, rather than duplicated into the route schema — matching
      // how the message-comment routes do it. The route's job is to surface that
      // rejection as a 400 rather than a 500.
      mocks.createFileCommentThread.mockRejectedValue(
        new mocks.CommentValidationError('body is required')
      );

      const response = await jsonPost(BASE, { body: '   ' });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ message: 'body is required' });
    });

    it('rejects a request with no body field at all before reaching the durable object', async () => {
      const response = await jsonPost(BASE, { quote: 'orphan quote' });

      expect(response.status).toBe(400);
      expect(mocks.createFileCommentThread).not.toHaveBeenCalled();
    });
  });

  describe('POST /:fileId/comments/:threadId/replies', () => {
    it('replies with the fileId threaded through so the DO can scope the lookup', async () => {
      const response = await jsonPost(`${BASE}/${THREAD_ID}/replies`, {
        body: 'Agreed',
        clientMutationId: 'reply-mutation-1',
      });

      expect(response.status).toBe(201);
      expect(mocks.createFileCommentReply).toHaveBeenCalledWith(expect.anything(), 'project-1', {
        fileId: FILE_ID,
        threadId: THREAD_ID,
        body: 'Agreed',
        clientMutationId: 'reply-mutation-1',
        actor: { kind: 'human', id: 'user-1', name: 'Ada' },
      });
    });
  });

  describe('POST /:fileId/comments/:threadId/{resolve,reopen}', () => {
    it.each([
      ['resolve', 'resolved'],
      ['reopen', 'open'],
    ])('%s sends status %s scoped by fileId', async (action, status) => {
      const response = await jsonPost(`${BASE}/${THREAD_ID}/${action}`, {});

      expect(response.status).toBe(200);
      expect(mocks.updateFileCommentThreadStatus).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        {
          fileId: FILE_ID,
          threadId: THREAD_ID,
          status,
          clientMutationId: null,
          actor: { kind: 'human', id: 'user-1', name: 'Ada' },
        }
      );
    });
  });

  describe('file/project binding', () => {
    it('404s and touches no comment storage when the file is not in this project', async () => {
      mocks.findFirst.mockResolvedValue(undefined);

      const response = await request(BASE);

      expect(response.status).toBe(404);
      expect(mocks.listFileCommentThreads).not.toHaveBeenCalled();
    });

    it('404s on create when the file is not in this project', async () => {
      mocks.findFirst.mockResolvedValue(undefined);

      const response = await jsonPost(BASE, { body: 'Sneaky' });

      expect(response.status).toBe(404);
      expect(mocks.createFileCommentThread).not.toHaveBeenCalled();
    });

    it('checks the binding before authorizing storage, not after', async () => {
      // The lookup must be scoped to BOTH the file and the project. Scoping to
      // the file alone would let a caller attach comments to another project's
      // file through their own project's durable object.
      await request(BASE);

      const where = mocks.findFirst.mock.calls[0]?.[0]?.where;
      expect(typeof where).toBe('function');
      const captured: string[] = [];
      where(
        { projectId: 'projectId', id: 'id' },
        {
          and: (...parts: string[]) => parts.join(' AND '),
          eq: (column: string, value: string) => {
            captured.push(`${column}=${value}`);
            return `${column}=${value}`;
          },
        }
      );
      expect(captured).toEqual(['projectId=project-1', `id=${FILE_ID}`]);
    });

    it('does not re-query D1 for reply/resolve/reopen', async () => {
      // Those reach their thread via WHERE id = ? AND file_id = ? inside the
      // project's own durable object, so an existing thread already proves the
      // binding was checked at create time. Re-checking is a wasted round trip.
      await jsonPost(`${BASE}/${THREAD_ID}/replies`, { body: 'Agreed' });
      await jsonPost(`${BASE}/${THREAD_ID}/resolve`, {});
      await jsonPost(`${BASE}/${THREAD_ID}/reopen`, {});

      expect(mocks.findFirst).not.toHaveBeenCalled();
    });

    it('propagates an authorization failure without touching comment storage', async () => {
      mocks.requireProjectCapability.mockRejectedValue(new AppError(403, 'FORBIDDEN', 'Denied'));

      const response = await jsonPost(BASE, { body: 'Not mine' });

      expect(response.status).toBe(403);
      expect(mocks.findFirst).not.toHaveBeenCalled();
      expect(mocks.createFileCommentThread).not.toHaveBeenCalled();
    });
  });

  describe('durable object error mapping', () => {
    it.each([
      ['CommentValidationError', () => new mocks.CommentValidationError('body is required'), 400],
      ['CommentNotFoundError', () => new mocks.CommentNotFoundError('Comment thread'), 404],
      ['CommentIdempotencyConflictError', () => new mocks.CommentIdempotencyConflictError(), 409],
      ['CommentLimitExceededError', () => new mocks.CommentLimitExceededError('too many'), 422],
    ])('maps %s to %i', async (_name, makeError, expected) => {
      mocks.createFileCommentThread.mockRejectedValue(makeError());

      const response = await jsonPost(BASE, { body: 'Needs clarification' });

      expect(response.status).toBe(expected);
    });

    it('maps an error that lost its class crossing the DO RPC boundary to 404, not 500', async () => {
      // Cloudflare RPC serializes a thrown error down to name/message — the class
      // and the `code` property do not survive. The first cut of these routes only
      // matched on the class, so this surfaced as an INTERNAL_ERROR.
      const serialized = new Error('Comment thread not found');
      serialized.name = 'Error';
      mocks.createFileCommentReply.mockRejectedValue(serialized);

      const response = await jsonPost(`${BASE}/${THREAD_ID}/replies`, { body: 'Agreed' });

      expect(response.status).toBe(404);
    });
  });
});
