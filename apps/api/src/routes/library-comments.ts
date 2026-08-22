/**
 * Library file comment routes.
 *
 * Project-scoped comments on library files (not session-scoped).
 * Mounted at /api/projects/:projectId/library
 */
import type { CommentStatus } from '@simple-agent-manager/shared';
import { COMMENT_STATUSES } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getAuth, getUserId } from '../middleware/auth';
import { errors } from '../middleware/error';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas/_validator';
import {
  CommentStatusMutationSchema,
  CreateCommentReplySchema,
  CreateLibraryFileCommentThreadSchema,
} from '../schemas/comments';
import * as projectDataService from '../services/project-data';

export const libraryCommentRoutes = new Hono<{ Bindings: Env }>();

function parseCommentStatus(rawStatus?: string): CommentStatus | null {
  if (!rawStatus) return null;
  const status = rawStatus.trim().toLowerCase();
  if (COMMENT_STATUSES.includes(status as CommentStatus)) return status as CommentStatus;
  throw errors.badRequest('status must be open, sent, or resolved');
}

function parsePositiveIntegerQuery(name: string, rawValue?: string): number | null {
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw errors.badRequest(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeIntegerQuery(name: string, rawValue?: string): number | null {
  if (!rawValue) return null;
  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw errors.badRequest(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function rethrowCommentError(err: unknown): never {
  const code =
    err && typeof err === 'object' && 'code' in err && typeof err.code === 'string'
      ? err.code
      : null;
  const name = err instanceof Error ? err.name : null;

  if (
    err instanceof projectDataService.CommentValidationError ||
    code === 'COMMENT_VALIDATION' ||
    name === 'CommentValidationError'
  ) {
    throw errors.badRequest(err instanceof Error ? err.message : 'Invalid comment request');
  }
  if (
    err instanceof projectDataService.CommentNotFoundError ||
    code === 'COMMENT_NOT_FOUND' ||
    name === 'CommentNotFoundError'
  ) {
    const resource =
      err && typeof err === 'object' && 'resource' in err && typeof err.resource === 'string'
        ? err.resource
        : 'Resource';
    throw errors.notFound(resource);
  }
  if (
    err instanceof projectDataService.CommentIdempotencyConflictError ||
    code === 'COMMENT_IDEMPOTENCY_CONFLICT' ||
    name === 'CommentIdempotencyConflictError'
  ) {
    throw errors.conflict(
      err instanceof Error
        ? err.message
        : 'clientMutationId already belongs to a different comment mutation'
    );
  }
  if (
    err instanceof projectDataService.CommentLimitExceededError ||
    code === 'COMMENT_LIMIT_EXCEEDED' ||
    name === 'CommentLimitExceededError'
  ) {
    throw errors.unprocessable(err instanceof Error ? err.message : 'Comment limit exceeded');
  }
  throw err;
}

async function verifyFileExists(env: Env, projectId: string, fileId: string) {
  const db = drizzle(env.DATABASE, { schema });
  const file = await db.query.projectFiles.findFirst({
    where: (f, { eq, and }) => and(eq(f.projectId, projectId), eq(f.id, fileId)),
    columns: { id: true },
  });
  if (!file) {
    throw errors.notFound('Library file');
  }
}

/**
 * GET /api/projects/:projectId/library/:fileId/comments
 * List comment threads for a library file.
 */
libraryCommentRoutes.get('/:fileId/comments', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const fileId = requireRouteParam(c, 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');
  await verifyFileExists(c.env, projectId, fileId);

  try {
    const result = await projectDataService.listCommentThreads(c.env, projectId, {
      fileId,
      anchorKind: 'library_file',
      status: parseCommentStatus(c.req.query('status')),
      afterSequence: parseNonNegativeIntegerQuery('afterSequence', c.req.query('afterSequence')),
      limit: parsePositiveIntegerQuery('limit', c.req.query('limit')),
    });
    return c.json(result);
  } catch (err) {
    rethrowCommentError(err);
  }
});

/**
 * POST /api/projects/:projectId/library/:fileId/comments
 * Create a comment thread on a library file.
 */
libraryCommentRoutes.post(
  '/:fileId/comments',
  jsonValidator(CreateLibraryFileCommentThreadSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const fileId = requireRouteParam(c, 'fileId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await verifyFileExists(c.env, projectId, fileId);

    const body = c.req.valid('json');
    try {
      const result = await projectDataService.createFileCommentThread(c.env, projectId, {
        fileId,
        body: body.body,
        quote: body.quote ?? null,
        clientMutationId: body.clientMutationId ?? null,
        actor: {
          kind: 'human',
          id: userId,
          name: getAuth(c).user.name ?? getAuth(c).user.email ?? null,
        },
      });
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/replies
 * Reply to a library file comment thread.
 */
libraryCommentRoutes.post(
  '/:fileId/comments/:threadId/replies',
  jsonValidator(CreateCommentReplySchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const fileId = requireRouteParam(c, 'fileId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await verifyFileExists(c.env, projectId, fileId);

    const body = c.req.valid('json');
    try {
      const result = await projectDataService.createCommentReply(c.env, projectId, {
        threadId,
        body: body.body,
        clientMutationId: body.clientMutationId ?? null,
        actor: {
          kind: 'human',
          id: userId,
          name: getAuth(c).user.name ?? getAuth(c).user.email ?? null,
        },
      });
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/resolve
 */
libraryCommentRoutes.post(
  '/:fileId/comments/:threadId/resolve',
  jsonValidator(CommentStatusMutationSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const fileId = requireRouteParam(c, 'fileId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await verifyFileExists(c.env, projectId, fileId);

    const body = c.req.valid('json');
    try {
      return c.json(
        await projectDataService.updateCommentThreadStatus(c.env, projectId, {
          threadId,
          status: 'resolved',
          clientMutationId: body.clientMutationId ?? null,
          actor: {
            kind: 'human',
            id: userId,
            name: getAuth(c).user.name ?? getAuth(c).user.email ?? null,
          },
        })
      );
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/reopen
 */
libraryCommentRoutes.post(
  '/:fileId/comments/:threadId/reopen',
  jsonValidator(CommentStatusMutationSchema),
  async (c) => {
    const userId = getUserId(c);
    const projectId = requireRouteParam(c, 'projectId');
    const fileId = requireRouteParam(c, 'fileId');
    const threadId = requireRouteParam(c, 'threadId');
    const db = drizzle(c.env.DATABASE, { schema });

    await requireProjectCapability(db, projectId, userId, 'task:write');
    await verifyFileExists(c.env, projectId, fileId);

    const body = c.req.valid('json');
    try {
      return c.json(
        await projectDataService.updateCommentThreadStatus(c.env, projectId, {
          threadId,
          status: 'open',
          clientMutationId: body.clientMutationId ?? null,
          actor: {
            kind: 'human',
            id: userId,
            name: getAuth(c).user.name ?? getAuth(c).user.email ?? null,
          },
        })
      );
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);
