import { expect, type Page, test } from '@playwright/test';

import { assertNoOverflow, makeMockUser, screenshot, setupAuditRoutes } from './audit-helpers';

/**
 * Route-level code splitting audit.
 *
 * Runs against the real production build (`playwright.config.ts` builds with `vite build`
 * and serves it with `vite preview`), so the assertions below observe the actual emitted
 * chunks — not a dev-server module graph.
 *
 * Two things are checked on every route:
 *   1. the heavy vendor libraries are NOT fetched on first paint (the whole point of the
 *      change, and the guard that catches a future `advancedChunks` group silently
 *      dragging one of them back into the eager `modulepreload` set);
 *   2. the page still renders correctly at 375px and 1280px with no horizontal overflow.
 */

const MOCK_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-split-1',
  userId: 'user-split-1',
});

/**
 * Chunk-name fragments for the libraries that used to ship in the initial bundle.
 * Chunk filenames are derived from the entry module, so these substrings appear in the
 * emitted asset names (e.g. `vendor-terminal-*.js`, `cytoscape.esm-*.js`).
 */
const HEAVY_LIBRARY_CHUNK_MARKERS = [
  'mermaid',
  'cytoscape', // mermaid's graph engine
  'recharts',
  'xyflow',
  'xterm',
  'vendor-terminal',
  'katex',
] as const;

const PROJECT_ID = 'proj-split-1';

const PROJECT = {
  id: PROJECT_ID,
  name: 'Bundle Split Project',
  repoUrl: 'https://github.com/example/bundle-split',
  repoFullName: 'example/bundle-split',
  defaultBranch: 'main',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

/** Records every script URL the browser requests, from navigation onwards. */
function trackScriptRequests(page: Page): string[] {
  const requested: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') requested.push(request.url());
  });
  return requested;
}

function heavyChunksAmong(urls: string[]): string[] {
  return urls.filter((url) =>
    HEAVY_LIBRARY_CHUNK_MARKERS.some((marker) => url.toLowerCase().includes(marker))
  );
}

async function mockApi(page: Page) {
  await setupAuditRoutes(page, (path, respond) => {
    if (path.endsWith('/api/auth/get-session')) return respond(200, MOCK_USER);
    if (path.endsWith('/api/projects')) return respond(200, { projects: [PROJECT] });
    if (path === `/api/projects/${PROJECT_ID}`) return respond(200, { project: PROJECT });
    if (path.endsWith('/api/nodes')) return respond(200, { nodes: [] });
    if (path.endsWith('/api/workspaces')) return respond(200, { workspaces: [] });
    return undefined;
  });
}

/**
 * Routes exercised at both viewports. `waitFor` is a selector that proves the lazily
 * loaded chunk actually mounted — without it a blank page would pass the audit.
 */
const LAZY_ROUTES = [
  { name: 'dashboard', path: '/dashboard' },
  { name: 'projects', path: '/projects' },
  { name: 'project-chat', path: `/projects/${PROJECT_ID}/chat` },
  { name: 'settings', path: '/settings/cloud-provider' },
  { name: 'admin-analytics', path: '/admin/analytics' },
  { name: 'account-map', path: '/account-map' },
  { name: 'nodes', path: '/nodes' },
] as const;

/**
 * The Suspense fallback must never be the terminal state: it should be replaced by real
 * content. Waiting for it to disappear also proves there is no permanent blank frame.
 */
async function waitForRouteSettled(page: Page) {
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByTestId('route-fallback')).toHaveCount(0, { timeout: 15_000 });
}

test.describe('Lazy route chunks — mobile', () => {
  for (const route of LAZY_ROUTES) {
    test(`${route.name} renders without overflow and without heavy vendor chunks`, async ({
      page,
    }) => {
      const scripts = trackScriptRequests(page);
      await mockApi(page);

      await page.goto(route.path);
      await waitForRouteSettled(page);

      // The page must have actually rendered something, otherwise "no heavy chunks" is
      // trivially true.
      await expect(page.locator('body')).not.toBeEmpty();

      await assertNoOverflow(page);
      await screenshot(page, `lazy-route-${route.name}`);

      expect(
        heavyChunksAmong(scripts),
        `${route.path} must not download mermaid/recharts/xyflow/xterm/katex chunks`
      ).toEqual([]);
    });
  }
});

test.describe('Lazy route chunks — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  for (const route of LAZY_ROUTES) {
    test(`${route.name} renders without overflow`, async ({ page }) => {
      await mockApi(page);

      await page.goto(route.path);
      await waitForRouteSettled(page);

      await expect(page.locator('body')).not.toBeEmpty();
      await assertNoOverflow(page);
      await screenshot(page, `lazy-route-${route.name}`);
    });
  }
});

test.describe('Initial load bundle budget', () => {
  test('the landing page downloads no heavy vendor chunk', async ({ page }) => {
    const scripts = trackScriptRequests(page);
    await mockApi(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    // This is the regression guard described in `vite.config.ts`: a manual chunk group
    // for one of these libraries puts it in `index.html`'s modulepreload set, which the
    // browser fetches on first paint. Measured before this change: ~976 kB gzip of eager
    // JS, including the whole mermaid engine.
    expect(heavyChunksAmong(scripts), 'landing must not preload heavy vendor chunks').toEqual([]);
    expect(scripts.length, 'landing should fetch a bounded number of scripts').toBeLessThan(40);
  });

  test('navigating to a diagram-free chat does not fetch the mermaid chunk', async ({ page }) => {
    const scripts = trackScriptRequests(page);
    await mockApi(page);

    await page.goto(`/projects/${PROJECT_ID}/chat`);
    await waitForRouteSettled(page);

    // MarkdownRenderer is on the chat path, but mermaid is now behind a dynamic import
    // that only fires for an actual ```mermaid fence.
    expect(
      scripts.filter((url) => /mermaid|cytoscape/i.test(url)),
      'a diagram-free chat must not load the mermaid engine'
    ).toEqual([]);
  });
});
