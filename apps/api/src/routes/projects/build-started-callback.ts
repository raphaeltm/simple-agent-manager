import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import * as v from 'valibot';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { jsonValidator } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
import { callbackTokenMatchesWorkspace } from '../../services/node-callback-auth';
import { notifyTaskRunnerWorkspaceBuildStarted } from '../../services/task-runner-do';

const BuildStartedCallbackSchema = v.object({
  workspaceId: v.string(),
});

/**
 * VM agent build-started callback — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket browser-session auth middleware. VM agents authenticate
 * with callback JWT Bearer tokens, not BetterAuth session cookies.
 */
const buildStartedCallbackRoute = new Hono<{ Bindings: Env }>();

buildStartedCallbackRoute.post(
  '/:projectId/tasks/:taskId/build-started',
  jsonValidator(BuildStartedCallbackSchema),
  async (c) => {
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env, { expectedScope: 'workspace' });
    const projectId = c.req.param('projectId');
    const taskId = c.req.param('taskId');
    const body = c.req.valid('json');

    if (!callbackTokenMatchesWorkspace(payload, body.workspaceId)) {
      log.error('build_started.callback_token_not_bound_to_workspace', {
        projectId,
        taskId,
        workspaceId: body.workspaceId,
        tokenIdentity: payload.workspace,
        action: 'rejected',
      });
      throw errors.forbidden('Callback token not authorized for this workspace');
    }

    const db = drizzle(c.env.DATABASE, { schema });
    const row = await db
      .select({
        workspaceId: schema.workspaces.id,
      })
      .from(schema.workspaces)
      .innerJoin(schema.tasks, eq(schema.tasks.workspaceId, schema.workspaces.id))
      .where(
        and(
          eq(schema.workspaces.id, body.workspaceId),
          eq(schema.workspaces.projectId, projectId),
          eq(schema.tasks.id, taskId),
          eq(schema.tasks.projectId, projectId)
        )
      )
      .get();

    if (!row) {
      log.error('build_started.workspace_task_binding_not_found', {
        projectId,
        taskId,
        workspaceId: body.workspaceId,
        action: 'rejected',
      });
      throw errors.forbidden('Workspace is not bound to this task');
    }

    await notifyTaskRunnerWorkspaceBuildStarted(c.env, taskId, body.workspaceId);
    return c.body(null, 204);
  }
);

export { buildStartedCallbackRoute };
