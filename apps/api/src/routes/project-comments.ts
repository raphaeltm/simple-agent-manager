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
    const status = parseCommentStatus(c.req.query('status'));
    const limit = parsePositiveIntegerQuery('limit', c.req.query('limit'));

    // Task visibility is viewer-specific and lives in D1. Resolve it before the Durable Object
    // ranks or counts candidates, otherwise private task activity can alter pagination metadata
    // and consume the capped page even when its bodies are filtered later.
    const readableTaskRows = await c.env.DATABASE.prepare(
      `SELECT a.id, a.title FROM asks a
        WHERE a.project_id = ? AND a.kind = 'task' AND ${TASK_READABLE_SQL}`
    )
      .bind(projectId, userId, userId)
      .all<{ id: string; title: string }>();
    const readableItems = readableTaskRows.results ?? [];
    const readable = new Set(readableItems.map((item) => item.id));

    const inbox = await projectDataService.listProjectCommentInbox(c.env, projectId, {
      status,
      limit,
      readableInboxItemIds: [...readable],
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

    // Defence in depth: the DO already excludes unreadable task threads before ranking and
    // counting, and the route still refuses to return a body or title it did not authorize.
    const itemThreads = inbox.inboxItemThreads ?? [];
    const returnedItemIds = new Set(itemThreads.map((thread) => thread.itemId));

    const response: ProjectCommentListResponse = {
      messageThreads: inbox.messageThreads,
      fileThreads: inbox.fileThreads,
      inboxItemThreads: itemThreads.filter((thread) => readable.has(thread.itemId)),
      inboxItems: readableItems
        .filter((item) => returnedItemIds.has(item.id))
        .map((item) => ({
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
