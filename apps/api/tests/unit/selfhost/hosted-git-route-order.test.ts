/**
 * The self-host build mounts the hosted git route after `src/index.ts` has registered every
 * shared route (`mountHostedGitRoute`, called by the generated celld entry). The route used to be
 * registered inside index.ts, right after the global middleware. This pins that a `/git/*`
 * request still runs exactly that middleware (preview, pages proxy, workspace proxy, request
 * logging, analytics, CORS) and then the git route, with nothing in between: no behaviour change
 * for a self-host install.
 *
 * Hono runs every matching handler in registration order, so the matching set is computed from
 * `app.routes` with Hono's own router.
 */
import { Hono } from 'hono';
import { TrieRouter } from 'hono/router/trie-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class Sandbox {} }));

const { app } = await import('../../../src/app');
await import('../../../src/index');
const { mountHostedGitRoute } = await import('../../../src/selfhost/hosted-git');

/** Registration indices of every route in `app.routes` that matches `method path`. */
function matching(method: string, path: string): number[] {
  const router = new TrieRouter<number>();
  app.routes.forEach((route, index) => router.add(route.method, route.path, index));
  const [handlers] = router.match(method, path);
  return handlers.map(([index]) => index).sort((a, b) => a - b);
}

describe('hosted git route position in the self-host build', () => {
  it('refuses to mount on an app index.ts has not registered on', () => {
    expect(() => mountHostedGitRoute(new Hono())).toThrow(/mount after src\/index.ts/);
  });

  it('runs after exactly the shared global middleware, and nothing else matches /git/*', () => {
    const sharedRouteCount = app.routes.length;
    // The shared entry alone serves no /git/* route: the Cloudflare build has none.
    expect(app.routes.some((route) => route.path.startsWith('/git'))).toBe(false);
    const globalMiddleware = matching('GET', '/no-such-route');

    mountHostedGitRoute(app);
    const gitRoute = app.routes.length - 1;
    expect(gitRoute).toBeGreaterThanOrEqual(sharedRouteCount);
    expect(app.routes[gitRoute]?.path).toBe('/git/*');

    // Liveness: preview, pages proxy, workspace proxy, logging, analytics and CORS all match.
    expect(globalMiddleware.length).toBeGreaterThanOrEqual(6);
    // All of them are registered before the first ordinary route, where the git route used to
    // sit; a later wildcard would run before the git route now but after it before.
    const firstOrdinaryRoute = app.routes.findIndex((route) => route.path === '/health');
    expect(firstOrdinaryRoute).toBeGreaterThan(0);
    expect(globalMiddleware.every((index) => index < firstOrdinaryRoute)).toBe(true);

    for (const [method, path] of [
      ['GET', '/git/repo-1.git/info/refs'],
      ['POST', '/git/repo-1.git/git-upload-pack'],
      ['POST', '/git/repo-1.git/git-receive-pack'],
    ] as const) {
      expect(matching(method, path)).toEqual([...globalMiddleware, gitRoute]);
    }
  });
});
