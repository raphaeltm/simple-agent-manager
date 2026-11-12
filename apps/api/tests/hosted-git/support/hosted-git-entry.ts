/**
 * Test Worker for the hosted git conformance suite. It wires the production pieces a self-hosted
 * install uses for SAM-hosted repositories: the git smart-HTTP route, the real project-create
 * route (artifacts provider) and the real workspace git-token route. Only authentication of the
 * browser session is replaced (an `x-test-user-id` header stands in for BetterAuth), plus two
 * test-only endpoints that mint credentials the production code would mint elsewhere.
 */
import { Hono } from 'hono';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { hostedGitTokenRoutes } from '../../../src/routes/projects/hosted-git-token';
import { registerProjectCreateRoute } from '../../../src/routes/projects/project-create';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
import { isLocalHostedGitActive } from '../../../src/services/hosted-git/backend';
import {
  handleHostedGitRequest,
  HOSTED_GIT_PATH_PREFIX,
} from '../../../src/services/hosted-git/http';
import { type HostedGitScope, mintHostedGitToken } from '../../../src/services/hosted-git/tokens';
import { signCurrentWorkspaceCallbackToken } from '../../../src/services/jwt';

export { HostedGitRepo } from '../../../src/durable-objects/hosted-git-repo';

const app = new Hono<{ Bindings: Env }>();
app.onError(handleAppError);

// Same mount as src/index.ts.
app.all(`${HOSTED_GIT_PATH_PREFIX}*`, async (c, next) => {
  if (!isLocalHostedGitActive(c.env)) return next();
  const response = await handleHostedGitRequest(c.req.raw, c.env);
  return response ?? next();
});

const projects = new Hono<{ Bindings: Env }>();
projects.use('*', async (c, next) => {
  const userId = c.req.header('x-test-user-id');
  if (!userId) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('auth' as never, { user: { id: userId, role: 'user', status: 'active' } } as never);
  await next();
});
registerProjectCreateRoute(projects);
projects.route('/', hostedGitTokenRoutes);
app.route('/api/projects', projects);
app.route('/api/workspaces', runtimeRoutes);

app.post('/__test/hosted-git-token', async (c) => {
  const body = await c.req.json<{
    repo: string;
    scope: HostedGitScope;
    ttlSeconds?: number;
    workspaceId?: string;
    userId?: string;
    callbackGeneration?: string | null;
  }>();
  return c.json(await mintHostedGitToken(c.env, body));
});

app.post('/__test/workspace-callback-token', async (c) => {
  const { workspaceId } = await c.req.json<{ workspaceId: string }>();
  return c.json({ token: await signCurrentWorkspaceCallbackToken(workspaceId, c.env) });
});

export default app;
