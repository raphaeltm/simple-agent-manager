/**
 * Library file comment routes.
 *
 * Project+file scoped (not session scoped). Mounted at
 * /api/projects/:projectId/library — auth is inherited from the `projectsRoutes`
 * wildcard, and every handler additionally asserts the caller's project
 * capability before touching data.
 */
import { drizzle } from 'drizzle-orm/d1';
import { type Context, Hono } from 'hono';

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

type LibraryCommentScope = {
  projectId: string;
  fileId: string;
  threadId: string;
};

/**
 * Resolves the route params and authorizes the caller for this project.
 *
 * Every handler below needs exactly this preamble, so it lives in one place —
 * a handler that forgot the capability check would otherwise be a one-line
 * omission with no visible symptom.
 */
async function authorizeScope(
  c: Context<{ Bindings: Env }>,
  capability: 'task:read' | 'task:write'
): Promise<LibraryCommentScope> {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const fileId = requireRouteParam(c, 'fileId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, capability);

  return { projectId, fileId, threadId: c.req.param('threadId') ?? '' };
}

/**
 * GET /api/projects/:projectId/library/:fileId/comments
 */
libraryCommentRoutes.get('/:fileId/comments', async (c) => {
  const { projectId, fileId } = await authorizeScope(c, 'task:read');

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
    const { projectId, fileId } = await authorizeScope(c, 'task:write');
    const body = c.req.valid('json');

    try {
      // Only the entry points that can introduce a NEW fileId need the binding
      // check. Reply/resolve/reopen reach their thread through a
      // `WHERE id = ? AND file_id = ?` lookup inside this project's own durable
      // object, so an existing thread already proves it was checked at create
      // time (.claude/rules/60-request-io-and-bundle-budgets.md).
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
    const { projectId, fileId, threadId } = await authorizeScope(c, 'task:write');
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
 * Resolve and reopen differ only in the status they write, so they share a
 * handler rather than existing as two near-identical copies.
 */
function statusMutationHandler(status: 'resolved' | 'open') {
  return async (c: Context<{ Bindings: Env }>) => {
    const { projectId, fileId, threadId } = await authorizeScope(c, 'task:write');
    const body = c.req.valid('json' as never) as { clientMutationId?: string | null };

    try {
      return c.json(
        await projectDataService.updateFileCommentThreadStatus(c.env, projectId, {
          fileId,
          threadId,
          status,
          clientMutationId: body.clientMutationId ?? null,
          actor: getCommentActor(c),
        })
      );
    } catch (err) {
      rethrowCommentError(err);
    }
  };
}

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/resolve
 */
libraryCommentRoutes.post(
  '/:fileId/comments/:threadId/resolve',
  jsonValidator(CommentStatusMutationSchema),
  statusMutationHandler('resolved')
);

/**
 * POST /api/projects/:projectId/library/:fileId/comments/:threadId/reopen
 */
libraryCommentRoutes.post(
  '/:fileId/comments/:threadId/reopen',
  jsonValidator(CommentStatusMutationSchema),
  statusMutationHandler('open')
);
