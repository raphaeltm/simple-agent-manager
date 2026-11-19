/**
 * Test Worker for the hosted git conformance suite. It wires the production pieces a self-hosted
 * install uses for SAM-hosted repositories: the git smart-HTTP route, the real project-create
 * route (artifacts provider) and the real workspace git-token route. Only authentication of the
 * browser session is replaced (an `x-test-user-id` header stands in for BetterAuth), plus two
 * test-only endpoints that mint credentials the production code would mint elsewhere.
 */
// The production entry (src/index.ts, imported by the celld entry) wires repo-hosting's ports
// first; the branch list, project create and import reach them, so this entry must too.
import '../../../src/repo-hosting-wiring';

import { Hono } from 'hono';

import { handleAppError } from '../../../src/middleware/app-error-handler';
import { registerProjectCreateRoute } from '../../../src/routes/projects/project-create';
import { repoBrowseRoutes } from '../../../src/routes/projects/repo-browse';
import { runtimeRoutes } from '../../../src/routes/workspaces/runtime';
// The self-host build's own module: the class and route the generated celld entry exports and mounts.
import { HostedGitRepo, mountHostedGitRoute } from '../../../src/selfhost/hosted-git';
import type { HostedGitEnv as Env } from '../../../src/selfhost/hosted-git/env';
import { hostedGitTokenRoutes } from '../../../src/selfhost/hosted-git/token-route';
import { type HostedGitScope, mintHostedGitToken } from '../../../src/selfhost/hosted-git/tokens';
import { invalidateAdminSettings } from '../../../src/services/admin-settings-resolution';
import { signCurrentWorkspaceCallbackToken } from '../../../src/services/jwt';

/** Test-only: run the GC alarm on demand (production schedules it 5 minutes after a push). */
export class HostedGitRepoTest extends HostedGitRepo {
  override async fetch(req: Request): Promise<Response> {
    if (new URL(req.url).pathname === '/__test/gc') {
      this.ctx.storage.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('gc-pending', '1') ON CONFLICT(key) DO UPDATE SET value = '1'"
      );
      await this.alarm();
      await this.ctx.storage.deleteAlarm();
      return new Response('ok');
    }
    if (new URL(req.url).pathname === '/__test/alarm' || new URL(req.url).pathname === '/__test/alarm-fail') {
      const store = (this as unknown as { store: { get: (...args: unknown[]) => Promise<unknown> } }).store;
      const get = store.get;
      if (new URL(req.url).pathname.endsWith('-fail')) store.get = async () => { throw new Error('injected transient read failure'); };
      await this.ctx.storage.deleteAlarm();
      try { await this.alarm(); } finally { store.get = get; }
      return new Response('ok');
    }
    if (new URL(req.url).pathname.startsWith('/__test/fail-read/')) {
      // One-shot: the next read of this object throws, as a storage fault or an exhausted work
      // budget would, so a push fails after its pack was ingested but before any ref decision.
      const oid = new URL(req.url).pathname.slice('/__test/fail-read/'.length);
      const store = (this as unknown as { store: { get: (oid: string, ...rest: unknown[]) => Promise<unknown> } }).store;
      const get = store.get;
      store.get = async (target: string, ...rest: unknown[]) => {
        if (target !== oid) return get.call(store, target, ...rest);
        store.get = get;
        throw new Error('injected read failure during push validation');
      };
      return new Response('ok');
    }
    if (new URL(req.url).pathname === '/__test/gc-state') {
      return Response.json({ pending: this.ctx.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE key='gc-pending'").toArray()[0]?.value, alarm: await this.ctx.storage.getAlarm() });
    }
    return super.fetch(req);
  }
}

const app = new Hono<{ Bindings: Env }>();
app.onError(handleAppError);

const projects = new Hono<{ Bindings: Env }>();
projects.use('*', async (c, next) => {
  const userId = c.req.header('x-test-user-id');
  if (!userId) return c.json({ error: 'UNAUTHORIZED' }, 401);
  c.set('auth' as never, { user: { id: userId, role: 'user', status: 'active' } } as never);
  await next();
});
registerProjectCreateRoute(projects);
projects.route('/', hostedGitTokenRoutes);
projects.route('/', repoBrowseRoutes);
app.route('/api/projects', projects);
app.route('/api/workspaces', runtimeRoutes);

// The production mount, after the other routes as in the generated celld entry.
mountHostedGitRoute(app);

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

app.post('/__test/gc/:repo', async (c) => {
  const ns = c.env.HOSTED_GIT!;
  await ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/__test/gc');
  const info = await ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/info');
  return c.json(await info.json());
});

app.get('/__test/info/:repo', async (c) => {
  const ns = c.env.HOSTED_GIT!;
  const info = await ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/info');
  return c.json(await info.json());
});

app.post('/__test/workspace-callback-token', async (c) => {
  const { workspaceId } = await c.req.json<{ workspaceId: string }>();
  return c.json({ token: await signCurrentWorkspaceCallbackToken(workspaceId, c.env) });
});

export default app;

app.post('/__test/invalidate-settings', (c) => {
  invalidateAdminSettings(c.env);
  return new Response('ok');
});

app.get('/__test/gc-state/:repo', async (c) => {
  const ns = c.env.HOSTED_GIT!;
  return ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/__test/gc-state');
});
app.delete('/__test/repository/:repo', async (c) => {
  const ns = c.env.HOSTED_GIT!;
  return ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/', { method: 'DELETE' });
});

app.post('/__test/fail-read/:repo/:oid', (c) => {
  const ns = c.env.HOSTED_GIT!;
  return ns.get(ns.idFromName(c.req.param('repo'))).fetch(`https://hosted-git/__test/fail-read/${c.req.param('oid')}`);
});

app.post('/__test/alarm/:repo/:mode', (c) => {
  const ns = c.env.HOSTED_GIT!;
  return ns.get(ns.idFromName(c.req.param('repo'))).fetch('https://hosted-git/__test/alarm' + (c.req.param('mode') === 'fail' ? '-fail' : ''));
});
