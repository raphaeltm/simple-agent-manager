/**
 * Project-wide comment inbox route.
 *
 * A comment thread renders beside the one message or file it annotates, so
 * discovering an unresolved comment used to mean scrolling the thing that
 * contains it. This endpoint is the index that fixes that: every thread in a
 * project, from chat and from the library, in a single request.
 *
 * It replaces a client-side fan-out that issued one request per recent session
 * plus one per library file — up to 52 requests to render one page
 * (.claude/rules/60-request-io-and-bundle-budgets.md).
 *
 * Mounted at /api/projects/:projectId/comments. Auth is inherited from the
 * `projectsRoutes` wildcard (session cookie); this is a browser-facing read, not
 * a VM-agent callback, so .claude/rules/34 does not apply. The handler still
 * asserts the caller's project capability explicitly before touching data.
 */
import { TASK_READABLE_SQL } from '@simple-agent-manager/operations';
import type { ProjectCommentListResponse } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../db/schema';
import type { Env } from '../env';
import {
  parseCommentStatus,
  parsePositiveIntegerQuery,
  rethrowCommentError,
} from '../lib/comment-http';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId } from '../middleware/auth';
import { requireProjectCapability } from '../middleware/project-auth';
import * as projectDataService from '../services/project-data';

export const projectCommentRoutes = new Hono<{ Bindings: Env }>();

/**
 * GET /api/projects/:projectId/comments
 *
 * Query params: `status` (open|sent|resolved), `limit`.
 */
projectCommentRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });

  await requireProjectCapability(db, projectId, userId, 'task:read');

  try {
    const inbox = await projectDataService.listProjectCommentInbox(c.env, projectId, {
      status: parseCommentStatus(c.req.query('status')),
      limit: parsePositiveIntegerQuery('limit', c.req.query('limit')),
    });

    // Filenames live in D1, not in the Durable Object, so they are resolved
    // here. Scoped by `project_id` as well as id: the DO cannot vouch for a
    // file's project, and a project-scoped read must bind the resource to the
    // authorized project rather than trusting an id that reached it
    // (.claude/rules/11 "Project-Scoped Read Requirements").
    const fileIds = [...new Set(inbox.fileThreads.map((thread) => thread.fileId))];
    const files =
      fileIds.length === 0
        ? []
        : await db.query.projectFiles.findMany({
            where: (f, { and, eq, inArray }) =>
              and(eq(f.projectId, projectId), inArray(f.id, fileIds)),
            columns: { id: true, filename: true },
          });

    // Task discussion (inbox slice H1) shares the one ranked read above. A team task is readable
    // by every member; a person's task only by its assignee and the person whose chat filed it,
    // so threads on items this viewer cannot read are dropped here (the DO cannot read D1).
    // `?? []`: an object still running the previous build returns no inbox-item threads.
    const itemThreads = inbox.inboxItemThreads ?? [];
    const itemIds = [...new Set(itemThreads.map((thread) => thread.itemId))];
    const readableItems =
      itemIds.length === 0
        ? []
        : ((
            await c.env.DATABASE.prepare(
              `SELECT a.id, a.title FROM asks a
                WHERE a.project_id = ? AND a.kind = 'task'
                  AND a.id IN (${itemIds.map(() => '?').join(', ')})
                  AND ${TASK_READABLE_SQL}`
            )
              .bind(projectId, ...itemIds, userId, userId)
              .all<{ id: string; title: string }>()
          ).results ?? []);
    const readable = new Set(readableItems.map((item) => item.id));

    const response: ProjectCommentListResponse = {
      messageThreads: inbox.messageThreads,
      fileThreads: inbox.fileThreads,
      inboxItemThreads: itemThreads.filter((thread) => readable.has(thread.itemId)),
      inboxItems: readableItems.map((item) => ({
        ref: `ask:${item.id}`,
        id: item.id,
        title: item.title,
      })),
      sessions: inbox.sessions,
      files,
      hasMore: inbox.hasMore,
      totalCount: inbox.totalCount,
    };

    return c.json(response);
  } catch (err) {
    rethrowCommentError(err);
  }
});
