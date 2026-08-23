/**
 * Library file comment routes.
 *
 * Project+file scoped (not session scoped). Mounted at
 * /api/projects/:projectId/library — auth is inherited from the `projectsRoutes`
 * wildcard, and every handler additionally asserts the caller's project
 * capability before touching data.
 */
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  getCommentActor,
  parseCommentStatus,
  parseNonNegativeIntegerQuery,
  parsePositiveIntegerQuery,
  rethrowCommentError,
} from '../lib/comment-http';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import { jsonValidator } from '../schemas/_validator';
import {
  CommentStatusMutationSchema,
  CreateCommentReplySchema,
  CreateLibraryFileCommentThreadSchema,
} from '../schemas/comments';
import { assertLibraryFileInProject } from '../services/library-file-comments';
import * as projectDataService from '../services/project-data';

export const libraryCommentRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/projects/:projectId/library/:fileId/comments
 */
libraryCommentRoutes.get('/:fileId/comments', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const fileId = requireRouteParam(c, 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');

  try {
    await assertLibraryFileInProject(c.env, projectId, fileId);
    const result = await projectDataService.listFileCommentThreads(c.env, projectId, {
      fileId,
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

    const body = c.req.valid('json');
    try {
      await assertLibraryFileInProject(c.env, projectId, fileId);
      const result = await projectDataService.createFileCommentThread(c.env, projectId, {
        fileId,
        body: body.body,
        quote: body.quote ?? null,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
      });
      return c.json(result, result.idempotent ? 200 : 201);
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/replies
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

    const body = c.req.valid('json');
    try {
      const result = await projectDataService.createFileCommentReply(c.env, projectId, {
        fileId,
        threadId,
        body: body.body,
        clientMutationId: body.clientMutationId ?? null,
        actor: getCommentActor(c),
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

    const body = c.req.valid('json');
    try {
      return c.json(
        await projectDataService.updateFileCommentThreadStatus(c.env, projectId, {
          fileId,
          threadId,
          status: 'resolved',
          clientMutationId: body.clientMutationId ?? null,
          actor: getCommentActor(c),
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

    const body = c.req.valid('json');
    try {
      return c.json(
        await projectDataService.updateFileCommentThreadStatus(c.env, projectId, {
          fileId,
          threadId,
          status: 'open',
          clientMutationId: body.clientMutationId ?? null,
          actor: getCommentActor(c),
        })
      );
    } catch (err) {
      rethrowCommentError(err);
    }
  }
);
