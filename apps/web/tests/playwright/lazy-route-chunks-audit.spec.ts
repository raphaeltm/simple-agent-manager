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

function heavyChunksAmong(urls: string[], allow: readonly string[] = []): string[] {
  return urls.filter((url) => {
    const lower = url.toLowerCase();
    if (allow.some((marker) => lower.includes(marker))) return false;
    return HEAVY_LIBRARY_CHUNK_MARKERS.some((marker) => lower.includes(marker));
  });
}

const WORKSPACE_ID = 'ws-split-1';

const WORKSPACE = {
  id: WORKSPACE_ID,
  name: 'split-workspace',
  status: 'running',
  nodeId: 'node-split-1',
  projectId: PROJECT_ID,
  userId: 'user-split-1',
  repoUrl: PROJECT.repoUrl,
  branch: 'main',
  createdAt: '2026-08-01T00:00:00Z',
  updatedAt: '2026-08-01T00:00:00Z',
};

/**
 * Endpoint → response body.
 *
 * `setupAuditRoutes`' own fallback is `{}`. Several of these endpoints return a BARE
 * ARRAY (`/api/credentials`, `/api/nodes`, `/api/github/installations`, …), so a `{}`
 * fallback makes the page throw (`.find is not a function`, `is not iterable`) and land
 * on the global ErrorBoundary. A crash screen satisfies "body is not empty", "no
 * overflow" and "no heavy vendor chunk" exactly as well as a real page — so without
 * accurate shapes AND the `expectNoCrashScreen` gate below, this audit would pass while
 * screenshotting crash screens. (It did, on 6 of 7 routes, until this was fixed.)
 *
 * Shapes verified against `apps/web/src/lib/api/*.ts` return types.
 */
const API_MOCKS: Array<[RegExp, unknown]> = [
  [/\/api\/auth\/get-session$/, MOCK_USER],
  [/\/api\/projects$/, { projects: [PROJECT] }],
  [new RegExp(`/api/projects/${PROJECT_ID}$`), { project: PROJECT }],
  // Bare-array endpoints
  [/\/api\/credentials$/, []],
  [/\/api\/github\/installations$/, []],
  [/\/api\/nodes$/, []],
  [/\/api\/workspaces$/, []],
  [new RegExp(`/api/workspaces/${WORKSPACE_ID}/agent-sessions$`), []],
  // Object endpoints. The workspace detail body is merged with the permissive
  // collections below because the workspace page maps over several optional lists.
  [new RegExp(`/api/workspaces/${WORKSPACE_ID}$`), WORKSPACE],
  [/\/api\/credentials\/agent$/, { credentials: [] }],
  [/\/api\/notifications$/, { notifications: [], total: 0, hasMore: false }],
  [/\/api\/notifications\/preferences$/, { preferences: {}, pushSubscriptions: [] }],
  [/\/api\/notifications\/unread-count$/, { count: 0 }],
  [/\/api\/providers\/catalog$/, { providers: [] }],
  // Shape from `AccountMapResponse` (apps/web/src/lib/api/projects.ts) — `relationships`
  // is mapped unconditionally, so omitting it crashes the page.
  [
    /\/api\/account-map$/,
    { projects: [], nodes: [], workspaces: [], sessions: [], tasks: [], relationships: [] },
  ],
  [/\/api\/report-issue\/config$/, { enabled: false }],
  [/\/api\/config\/vapid-public-key$/, { publicKey: null }],
  // `NodeSystemInfo` (packages/shared/src/types/workspace.ts). The workspace sidebar
  // reads `systemInfo.cpu.loadAvg1` behind a truthiness check on `systemInfo` only, so
  // a generic `{}` passes the guard and then throws on the missing nested object.
  [
    /\/api\/nodes\/[^/]+\/system-info$/,
    {
      cpu: { loadAvg1: 0, loadAvg5: 0, loadAvg15: 0, numCpu: 2 },
      memory: { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0 },
      disk: { totalBytes: 0, usedBytes: 0, availableBytes: 0, usedPercent: 0, mountPath: '/' },
      network: { interface: 'eth0', rxBytes: 0, txBytes: 0 },
    },
  ],
];

/**
 * Admin analytics renders numeric KPI cards. Several components short-circuit on an
 * explicit zero (e.g. `AIUsageChart.tsx:48` returns early when `totalRequests === 0`)
 * but crash on `undefined` — so the zeros below are load-bearing, not decoration.
 */
const ADMIN_ANALYTICS_MOCK = {
  series: [],
  points: [],
  rows: [],
  events: [],
  countries: [],
  cohorts: [],
  steps: [],
  features: [],
  models: [],
  byModel: [],
  byDay: [],
  days: [],
  total: 0,
  totalRequests: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostUsd: 0,
  trialRequests: 0,
  trialCostUsd: 0,
  cachedRequests: 0,
  uniqueUsers: 0,
  unique_users: 0,
  count: 0,
  enabled: false,
  forwarding: { enabled: false, lastForwardedAt: null },
};

/**
 * Fallback for endpoints not modelled above: empty collections under every common list
 * key, so a page reading `body.<something>` gets an array rather than `undefined`.
 */
const PERMISSIVE_EMPTY_BODY = {
  projects: [],
  nodes: [],
  workspaces: [],
  tasks: [],
  sessions: [],
  chats: [],
  messages: [],
  items: [],
  results: [],
  data: [],
  events: [],
  credentials: [],
  agents: [],
  profiles: [],
  triggers: [],
  ideas: [],
  files: [],
  users: [],
  ports: [],
  total: 0,
  count: 0,
  hasMore: false,
};

async function mockApi(page: Page) {
  await setupAuditRoutes(page, (path, respond) => {
    for (const [pattern, body] of API_MOCKS) {
      if (pattern.test(path)) {
        // Object bodies are merged over the permissive defaults so a page reading an
        // optional list the fixture omits still gets an array.
        const merged =
          Array.isArray(body) || body === null
            ? body
            : { ...PERMISSIVE_EMPTY_BODY, ...(body as Record<string, unknown>) };
        return respond(200, merged);
      }
    }
    if (path.startsWith('/api/admin/analytics/')) {
      return respond(200, { ...PERMISSIVE_EMPTY_BODY, ...ADMIN_ANALYTICS_MOCK });
    }
    return respond(200, PERMISSIVE_EMPTY_BODY);
  });
}

/**
 * The global ErrorBoundary renders "Something went wrong" (`ErrorBoundary.tsx:85`).
 * Every route assertion below depends on this: without it, a page that throws during
 * render still passes every other check in this file.
 */
async function expectNoCrashScreen(page: Page, routePath: string) {
  await expect(
    page.getByText('Something went wrong'),
    `${routePath} rendered the global ErrorBoundary instead of the page`
  ).toHaveCount(0);
}

/**
 * Routes exercised at both viewports. `waitFor` is a selector that proves the lazily
 * loaded chunk actually mounted — without it a blank page would pass the audit.
 */
/**
 * `allowHeavy` lists the chunk markers a route is *entitled* to fetch, because that
 * library is what the route is for. The point of the change is that a library loads only
 * on the route that needs it — never eagerly, and never on unrelated routes — so a
 * blanket "no heavy chunks anywhere" rule would be wrong (it would forbid the workspace
 * terminal from loading xterm at all).
 */
const LAZY_ROUTES = [
  { name: 'dashboard', path: '/dashboard', allowHeavy: [] },
  { name: 'projects', path: '/projects', allowHeavy: [] },
  { name: 'project-chat', path: `/projects/${PROJECT_ID}/chat`, allowHeavy: [] },
  { name: 'settings', path: '/settings/cloud-provider', allowHeavy: [] },
  { name: 'admin-analytics', path: '/admin/analytics', allowHeavy: ['recharts'] },
  { name: 'account-map', path: '/account-map', allowHeavy: ['xyflow'] },
  { name: 'nodes', path: '/nodes', allowHeavy: [] },
  // The workspace route is the whole justification for the `vendor-terminal` chunk
  // group, so it must be audited even though it renders outside the AppShell.
  {
    name: 'workspace',
    path: `/workspaces/${WORKSPACE_ID}`,
    allowHeavy: ['xterm', 'vendor-terminal'],
  },
] as const;

/**
 * The Suspense fallback must never be the terminal state: it should be replaced by real
 * content. Waiting for it to disappear also proves there is no permanent blank frame.
 */
async function waitForRouteSettled(page: Page) {
  // Bounded: the workspace route holds a terminal WebSocket open, so `networkidle` never
  // fires there. The fallback-gone assertion is the real signal.
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
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

      // The page must have actually rendered, otherwise "no heavy chunks" is trivially
      // true — a crash screen would pass every other assertion in this test.
      await expect(page.locator('body')).not.toBeEmpty();
      await expectNoCrashScreen(page, route.path);

      await assertNoOverflow(page);
      await screenshot(page, `lazy-route-${route.name}`);

      expect(
        heavyChunksAmong(scripts, route.allowHeavy),
        `${route.path} must not download heavy vendor chunks it does not use`
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
      await expectNoCrashScreen(page, route.path);
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

  /**
   * Name-independent backstop for the substring markers above.
   *
   * `heavyChunksAmong` can only catch a library whose CHUNK NAME contains a known
   * marker. A future `advancedChunks` group named something else (`{name: 'diagrams',
   * packages: ['mermaid','recharts']}`) would evade every marker while reintroducing the
   * exact eager-bundle regression. A byte budget cannot be evaded by renaming.
   *
   * Baseline before this change: 3,624.9 kB of eager JS. After: 718.8 kB. The ceiling is
   * set at roughly 2x the current figure so ordinary growth does not trip it, while any
   * heavy library re-entering the initial graph (the smallest offender, `vendor-charts`,
   * is ~340 kB; mermaid is ~2.7 MB) does.
   */
  test('first-paint JS stays within the initial-load byte budget', async ({ page }) => {
    const EAGER_JS_BUDGET_BYTES = 1_500_000;

    let totalBytes = 0;
    const perChunk: Array<[string, number]> = [];
    page.on('response', async (response) => {
      if (response.request().resourceType() !== 'script') return;
      try {
        const body = await response.body();
        totalBytes += body.byteLength;
        perChunk.push([new URL(response.url()).pathname, body.byteLength]);
      } catch {
        /* response body unavailable (redirect/cache) — ignore */
      }
    });

    await mockApi(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle').catch(() => undefined);

    const largest = perChunk
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, size]) => `${name} ${(size / 1024).toFixed(1)}kB`)
      .join(', ');

    expect(
      totalBytes,
      `first-paint JS is ${(totalBytes / 1024).toFixed(1)} kB (budget ${(
        EAGER_JS_BUDGET_BYTES / 1024
      ).toFixed(0)} kB). Largest: ${largest}`
    ).toBeLessThan(EAGER_JS_BUDGET_BYTES);
  });
});

test.describe('Stale chunk recovery', () => {
  /**
   * The production failure this whole mechanism exists for: content-hashed assets plus a
   * redeploy means an open session's lazy `import()` 404s.
   *
   * This is the only test that drives the recovery ladder through a REAL browser with a
   * REAL dynamic import — the unit tests in `lazy-with-retry.test.ts` feed hand-written
   * error strings to `importWithRetry` and therefore cannot prove that a genuine chunk
   * 404 produces an error `isChunkLoadError` actually recognises.
   */
  test('a 404ing route chunk is retried, then recovered by a single reload', async ({ page }) => {
    await mockApi(page);

    let chunkRequests = 0;
    // Serve the SPA fallback (HTML with a 200) for the Nodes route chunk — exactly what
    // an origin does for a hashed filename that no longer exists.
    await page.route(/\/assets\/Nodes-[^/]*\.js(\?.*)?$/, async (route) => {
      chunkRequests += 1;
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: '<!doctype html><html><body>not the chunk</body></html>',
      });
    });

    const reloads: string[] = [];
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) reloads.push(frame.url());
    });

    // Navigate straight to the broken route. This must be the FIRST navigation: once the
    // service worker (`src/sw.ts`) has registered it handles script fetches itself, and
    // Playwright's `page.route` does not see service-worker-initiated requests.
    await page.goto('/nodes').catch(() => undefined);
    // Retry delay + reload round trip.
    await page.waitForTimeout(5_000);

    // The broken chunk was actually requested — without this the assertions below could
    // pass on a page that never attempted the import at all.
    expect(chunkRequests, 'the failing route chunk should have been requested').toBeGreaterThan(0);

    // NOTE: deliberately not asserting a SECOND request. Chromium's module map caches a
    // failed specifier for the document's lifetime, so `importWithRetry`'s retry rung
    // resolves from that cached rejection rather than refetching. The reload rung below
    // is what actually recovers the session, and is what this test pins down.
    //
    // The reload fired, recorded in sessionStorage so it can never loop.
    const marker = await page.evaluate(() => window.sessionStorage.getItem('sam:chunk-reload-at'));
    expect(marker, 'a chunk-recovery reload should be recorded exactly once').not.toBeNull();

    // The loop guard holds: the app is not stuck reloading forever.
    const reloadCountAfterFirst = reloads.length;
    await page.waitForTimeout(3_000);
    expect(
      reloads.length,
      'the loop guard must stop further reloads once the marker is set'
    ).toBeLessThanOrEqual(reloadCountAfterFirst + 1);
  });
});
