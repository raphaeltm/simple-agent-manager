/**
 * The Ideas list, one idea, and the status a person chooses for it.
 *
 * Mounted at `/api/projects/:projectId/ideas`. These are the reads the redesigned Ideas list
 * and idea page use; they return each idea's state derived from its linked work rather than a
 * status someone typed. Session–idea *linking* stays on the chat routes (`chat-ideas.ts`), and
 * creating or editing an idea stays on the shared idea operations used by every surface.
 *
 * The list reads stored pull request state only. It never asks GitHub, because one person
 * opening the page would otherwise cost one GitHub call per pull request in the project.
 */
import { IDEA_HUMAN_TRANSITIONS } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt, requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { requireProjectAccess, requireProjectCapability } from '../middleware/project-auth';
import { toOperationHttpError } from '../operations/errors';
import { createIdea } from '../operations/idea-core';
import {
  getIdeaWithDerivedStatus,
  type IdeaPullRequestStateReader,
  listIdeasWithDerivedStatus,
} from '../operations/idea-list-core';
import { acknowledgeIdeaMerge, applyIdeaStatusTransition } from '../operations/idea-transitions';
import { type OperationContext, webOperationContext } from '../operations/types';
import { jsonValidator } from '../schemas';

export const ideaRoutes = new Hono<{ Bindings: Env }>();

ideaRoutes.use('/*', requireAuth(), requireApproved());

const UpdateIdeaStatusSchema = v.object({
  // Built from the shared list rather than repeating it, so the schema and
  // `isIdeaHumanTransition` cannot disagree about what a person is allowed to choose.
  status: v.picklist(IDEA_HUMAN_TRANSITIONS),
});

const CreateIdeaSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1, 'title is required')),
  content: v.optional(v.string()),
});

/**
/**
 * How much each read may spend on pull request state.
 *
 * The list reads a whole page — up to `openLimit` ideas — so it must never ask anyone to call
 * GitHub: one refresh per idea would be a hundred calls for one page view. Only the
 * single-idea read may ask, and only for its own pull requests. Exported so a test can pin
 * the choice rather than trusting the call sites to stay right.
 */
export const IDEA_PULL_REQUEST_REFRESH = {
  list: 'none',
  detail: 'single',
} as const satisfies Record<string, 'single' | 'none'>;

/**
 * Stored pull request state for the URLs an idea's work produced.
 *
 * T2 owns pull request state (`operations/pull-request-core.ts`); this is only the adapter
 * that reshapes its answer for the Ideas reads. Until that operation is on `main` the Ideas
 * pages show state-free pull requests, which is why T8 does not merge before it — see the
 * `feature.linked-work` channel and idea 01M5NG5KPW7PXY272F2SVCB1SN.
 */
function pullRequestStateReader(
  _ctx: OperationContext,
  _projectId: string,
  _refresh: (typeof IDEA_PULL_REQUEST_REFRESH)[keyof typeof IDEA_PULL_REQUEST_REFRESH]
): IdeaPullRequestStateReader {
  return async () => ({});
}

/**
 * GET / — the Ideas list, with each idea's derived state, counts and needs-you reason.
 */
ideaRoutes.get('/', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, userId);

  const ctx = webOperationContext(c, userId);
  const openLimit = parsePositiveInt(c.req.query('openLimit'), 0) || undefined;
  const closedLimit = parsePositiveInt(c.req.query('closedLimit'), 0) || undefined;

  try {
    const result = await listIdeasWithDerivedStatus(ctx, {
      projectId,
      openLimit,
      closedLimit,
      readPullRequestStates: pullRequestStateReader(ctx, projectId, IDEA_PULL_REQUEST_REFRESH.list),
    });
    return c.json(result);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});

/**
 * POST / — file a new idea.
 *
 * Goes through the same `createIdea` operation the MCP tools use, so an idea a person types
 * and an idea an agent files are the same kind of row (rule 24).
 */
ideaRoutes.post('/', jsonValidator(CreateIdeaSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');

  const body = c.req.valid('json');
  const ctx = webOperationContext(c, userId);
  try {
    const created = await createIdea(ctx, {
      projectId,
      title: body.title,
      content: body.content,
    });
    const idea = await getIdeaWithDerivedStatus(ctx, {
      projectId,
      ideaId: created.ideaId,
      readPullRequestStates: pullRequestStateReader(ctx, projectId, IDEA_PULL_REQUEST_REFRESH.list),
    });
    return c.json(idea, 201);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});

/**
 * GET /:ideaId — one idea: the current plan, its derived state, its work and its counts.
 */
ideaRoutes.get('/:ideaId', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const ideaId = requireRouteParam(c, 'ideaId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectAccess(db, projectId, userId);

  const ctx = webOperationContext(c, userId);
  try {
    // The detail page is one idea, so it may ask T2 for a bounded background refresh.
    const idea = await getIdeaWithDerivedStatus(ctx, {
      projectId,
      ideaId,
      readPullRequestStates: pullRequestStateReader(
        ctx,
        projectId,
        IDEA_PULL_REQUEST_REFRESH.detail
      ),
    });
    return c.json(idea);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});

/**
 * POST /:ideaId/status — "Mark done", "Park" and "Keep open".
 *
 * The one server operation for idea transitions, shared with `update_idea` and the generic
 * task status route, so every surface agrees on what is allowed.
 */
ideaRoutes.post('/:ideaId/status', jsonValidator(UpdateIdeaStatusSchema), async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const ideaId = requireRouteParam(c, 'ideaId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');

  const body = c.req.valid('json');

  const ctx = webOperationContext(c, userId);
  try {
    const result = await applyIdeaStatusTransition(ctx, {
      projectId,
      ideaId,
      status: body.status,
    });
    log.info('ideas.status_changed', {
      projectId,
      ideaId,
      userId,
      fromStatus: result.fromStatus,
      toStatus: result.toStatus,
      changed: result.changed,
    });
    const idea = await getIdeaWithDerivedStatus(ctx, {
      projectId,
      ideaId,
      readPullRequestStates: pullRequestStateReader(ctx, projectId, IDEA_PULL_REQUEST_REFRESH.list),
    });
    return c.json(idea);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});

/**
 * POST /:ideaId/keep-open — "Keep open", the other answer to "a pull request merged, is this
 * idea done?".
 *
 * It changes no status. It records that a person answered, so the question does not come
 * back every time the list is read.
 */
ideaRoutes.post('/:ideaId/keep-open', async (c) => {
  const userId = getUserId(c);
  const projectId = requireRouteParam(c, 'projectId');
  const ideaId = requireRouteParam(c, 'ideaId');
  const db = drizzle(c.env.DATABASE, { schema });
  await requireProjectCapability(db, projectId, userId, 'task:write');

  const ctx = webOperationContext(c, userId);
  try {
    const result = await acknowledgeIdeaMerge(ctx, { projectId, ideaId });
    log.info('ideas.merge_kept_open', {
      projectId,
      ideaId,
      userId,
      acknowledgedAt: result.acknowledgedAt,
    });
    const idea = await getIdeaWithDerivedStatus(ctx, {
      projectId,
      ideaId,
      readPullRequestStates: pullRequestStateReader(ctx, projectId, IDEA_PULL_REQUEST_REFRESH.list),
    });
    return c.json(idea);
  } catch (error) {
    throw toOperationHttpError(error);
  }
});
