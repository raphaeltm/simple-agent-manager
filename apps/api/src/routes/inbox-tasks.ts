/**
 * Human tasks, the person side (inbox slice H1): tick a step, comment, take a team task, hand it
 * on, mark it done, reopen it. Archive is the inbox's own `POST …/items/:ref/archive`, which closes
 * a task through the same operation. Each route is a thin adapter over
 * `packages/operations/src/inbox-task-core.ts`; the task view is `GET …/items/:ref` (`task`).
 *
 * Mounted at `/api/projects/:projectId/inbox` beside `projectInboxRoutes`. Browser-facing session
 * routes (rule 34 does not apply); writes require the app's Origin and a JSON body like every
 * other inbox write. `:ref` is `ask:<id>`; any other ref names no task and reads not-found.
 */
import {
  claimTask,
  commentOnTask,
  completeTask,
  reassignTask,
  reopenTask,
  setTaskStep,
  TASK_NOT_FOUND,
  toOperationHttpError,
} from '@simple-agent-manager/operations';
import { parseInboxRef } from '@simple-agent-manager/shared';
import { type Context, Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../env';
import { requireRouteParam } from '../lib/route-helpers';
import { getUserId, requireApproved, requireAuth } from '../middleware/auth';
import { errors } from '../middleware/error';
import { webOperationContext } from '../operation-ports';
import { jsonValidator } from '../schemas/_validator';
import { assertBrowserJsonWrite } from './projects/secret-requests';

const session = [requireAuth(), requireApproved()] as const;
type AppContext = Context<{ Bindings: Env }>;

// Lengths are checked by the operations against `inbox.answerMaxChars`; these bound the shape.
const StepSchema = v.object({ done: v.boolean() });
const CommentSchema = v.object({
  body: v.pipe(v.string(), v.minLength(1), v.maxLength(20_000)),
  threadId: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(128))),
  mentions: v.optional(
    v.pipe(
      v.array(v.object({ userId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) })),
      v.maxLength(20)
    )
  ),
});
const ReassignSchema = v.union([
  v.object({ assigneeUserId: v.pipe(v.string(), v.minLength(1), v.maxLength(128)) }),
  v.object({ team: v.literal(true) }),
]);
const DoneSchema = v.object({ note: v.optional(v.pipe(v.string(), v.maxLength(20_000))) });
const EmptySchema = v.object({});

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toOperationHttpError(error);
  }
}

function target(c: AppContext): { projectId: string; askId: string } {
  const parsed = parseInboxRef(requireRouteParam(c, 'ref'));
  if (!parsed || parsed.store !== 'ask') throw errors.notFound(TASK_NOT_FOUND);
  return { projectId: requireRouteParam(c, 'projectId'), askId: parsed.id };
}

function context(c: AppContext) {
  assertBrowserJsonWrite(c, 'inbox');
  return webOperationContext(c, getUserId(c));
}

export const projectInboxTaskRoutes = new Hono<{ Bindings: Env }>();

projectInboxTaskRoutes.post(
  '/items/:ref/steps/:index',
  ...session,
  jsonValidator(StepSchema),
  async (c) => {
    const ctx = context(c);
    const index = Number.parseInt(requireRouteParam(c, 'index'), 10);
    if (!Number.isSafeInteger(index) || index < 0) throw errors.badRequest('No such step');
    const { done } = c.req.valid('json');
    return c.json(await run(() => setTaskStep(ctx, { ...target(c), index, done })));
  }
);

projectInboxTaskRoutes.post(
  '/items/:ref/comments',
  ...session,
  jsonValidator(CommentSchema),
  async (c) => {
    const ctx = context(c);
    const body = c.req.valid('json');
    return c.json(
      await run(() =>
        commentOnTask(ctx, {
          ...target(c),
          body: body.body,
          threadId: body.threadId,
          mentionUserIds: body.mentions?.map((mention) => mention.userId),
        })
      )
    );
  }
);

projectInboxTaskRoutes.post('/items/:ref/claim', ...session, jsonValidator(EmptySchema), async (c) => {
  const ctx = context(c);
  return c.json(await run(() => claimTask(ctx, target(c))));
});

projectInboxTaskRoutes.post(
  '/items/:ref/reassign',
  ...session,
  jsonValidator(ReassignSchema),
  async (c) => {
    const ctx = context(c);
    const body = c.req.valid('json');
    return c.json(
      await run(() =>
        reassignTask(ctx, {
          ...target(c),
          ...('team' in body ? { team: true } : { assigneeUserId: body.assigneeUserId }),
        })
      )
    );
  }
);

projectInboxTaskRoutes.post('/items/:ref/done', ...session, jsonValidator(DoneSchema), async (c) => {
  const ctx = context(c);
  const { note } = c.req.valid('json');
  return c.json(await run(() => completeTask(ctx, { ...target(c), note })));
});

projectInboxTaskRoutes.post('/items/:ref/reopen', ...session, jsonValidator(EmptySchema), async (c) => {
  const ctx = context(c);
  return c.json(await run(() => reopenTask(ctx, target(c))));
});
