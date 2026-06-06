import { expect, type Page, type Route, test } from '@playwright/test';

const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

const MOCK_USER = {
  user: {
    id: 'admin-theme-1',
    email: 'admin@example.com',
    name: 'Admin User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-admin-theme-1',
    userId: 'admin-theme-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

async function seedTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => {
    window.localStorage.setItem('sam-theme', value);
  }, theme);
}

async function expectTheme(page: Page, theme: 'dark' | 'light') {
  const expected = theme === 'dark' ? 'sam' : 'sam-light';
  const attr = await page.evaluate(() => document.documentElement.getAttribute('data-ui-theme'));
  expect(attr).toBe(expected);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
}

function makeCostSummary(empty = false) {
  return {
    llm: {
      totalCostUsd: empty ? 0 : 98765.4321,
      totalRequests: empty ? 0 : 123456789,
      totalInputTokens: empty ? 0 : 987654321,
      totalOutputTokens: empty ? 0 : 123456789,
      trialCostUsd: empty ? 0 : 12.3456,
      cachedRequests: empty ? 0 : 4321,
      errorRequests: empty ? 0 : 98,
      byModel: empty ? [] : Array.from({ length: 8 }, (_, i) => ({
        model: `@cf/vendor/model-with-a-very-long-name-${i}`,
        provider: i % 2 === 0 ? 'workers-ai' : 'openai',
        requests: 900000 - i * 71000,
        inputTokens: 70000000 - i * 3000000,
        outputTokens: 12000000 - i * 500000,
        costUsd: 1200.4321 / (i + 1),
      })),
      byDay: empty ? [] : Array.from({ length: 14 }, (_, i) => ({
        date: `2026-05-${String(i + 1).padStart(2, '0')}`,
        requests: 1000 + i * 250,
        costUsd: i === 0 ? 0.0004 : 12.45 + i * 8.25,
      })),
      byUser: empty ? [] : Array.from({ length: 30 }, (_, i) => ({
        userId: `user-with-long-stable-id-${String(i).padStart(2, '0')}-abcdef`,
        requests: 100000 - i * 1200,
        inputTokens: 8000000 - i * 50000,
        outputTokens: 900000 - i * 20000,
        costUsd: i === 0 ? 0.0042 : 99.99 / (i + 1),
      })),
    },
    projection: {
      projectedMonthlyCostUsd: empty ? 0 : 123456.78,
      dailyAverageCostUsd: empty ? 0 : 3982.47,
      daysElapsed: 17,
      daysInMonth: 31,
    },
    compute: {
      totalNodeHours: empty ? 0 : 12345.67,
      totalVcpuHours: empty ? 0 : 98765.43,
      estimatedCostUsd: empty ? 0 : 4321.99,
      activeNodes: empty ? 0 : 42,
      vcpuHourCostUsd: 0.0123,
    },
    period: '30d',
    periodLabel: empty ? 'No activity' : 'Large-number stress period',
  };
}

function makeLogs() {
  return Array.from({ length: 35 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 4, 1, 10, i % 60, 0)).toISOString(),
    level: (['error', 'warn', 'info', 'debug', 'log'] as const)[i % 5],
    event: `admin.audit.event.${i}`,
    message: `Log row ${i} with a long message, URL https://example.com/path/${i}, unicode cafe, and <script>alert("x")</script> text`,
    details: {
      requestId: `req-${i}`,
      nested: { value: 'debug detail payload should stay code-like and scrollable' },
    },
    scriptName: i % 2 === 0 ? 'sam-api-staging' : 'sam-tail-worker',
  }));
}

function makeErrors() {
  return Array.from({ length: 30 }, (_, i) => ({
    id: `err-${i}`,
    timestamp: new Date(Date.UTC(2026, 4, 1, 11, i % 60, 0)).toISOString(),
    source: (['client', 'vm-agent', 'api'] as const)[i % 3],
    level: (['error', 'warn', 'info'] as const)[i % 3],
    message: `Error ${i}: long diagnostic message with workspace ws-${i}, node node-${i}, and copy-pasteable context`,
    stack: `Error: failure ${i}\n    at handler (/worker/src/index.ts:${20 + i}:5)\n    at async dispatch`,
    context: { requestId: `req-${i}`, path: `/api/projects/${i}` },
    userId: `user-${i}`,
    workspaceId: `workspace-${i}`,
    nodeId: `node-${i}`,
  }));
}

async function setupAdminMocks(page: Page, options: { emptyCosts?: boolean; errorCosts?: boolean; errorLists?: boolean } = {}) {
  const respond = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;

    if (path.includes('/api/auth/')) return respond(route, 200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(route, 200, { notifications: [], unreadCount: 0 });
    if (path.includes('/api/admin/costs')) {
      if (options.errorCosts) return respond(route, 500, { error: 'Cost backend unavailable' });
      return respond(route, 200, makeCostSummary(options.emptyCosts));
    }
    if (path.includes('/api/admin/observability/logs/query')) {
      if (options.errorLists) return respond(route, 500, { error: 'Log query failed' });
      return respond(route, 200, { logs: makeLogs(), cursor: null, queryId: 'query-1', hasMore: false });
    }
    if (path.includes('/api/admin/observability/errors')) {
      if (options.errorLists) return respond(route, 500, { error: 'Error query failed' });
      return respond(route, 200, { errors: makeErrors(), total: 30, cursor: null, hasMore: false });
    }
    if (path.includes('/api/admin/observability/trends')) {
      return respond(route, 200, { buckets: [], range: '24h' });
    }
    if (path.includes('/api/admin/health')) return respond(route, 200, { status: 'ok' });
    if (path.startsWith('/api/projects')) return respond(route, 200, { projects: [], nextCursor: null });
    return respond(route, 200, {});
  });
}

async function auditRoute(page: Page, theme: 'dark' | 'light', route: string, name: string, options = {}) {
  await seedTheme(page, theme);
  await setupAdminMocks(page, options);
  await page.goto(route);
  await page.waitForTimeout(900);
  await expectTheme(page, theme);
  await screenshot(page, `admin-${name}-${theme}`);
  await assertNoHorizontalOverflow(page);
}

test.describe('Admin Chrome Theme — Mobile (375x667)', () => {
  test.skip(({ viewport }) => viewport?.width !== 375, 'Mobile audit runs only on the 375px project');

  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('cost dashboard dark and light', async ({ page }) => {
    await auditRoute(page, 'dark', '/admin/costs', 'costs-large-mobile');
    await auditRoute(page, 'light', '/admin/costs', 'costs-large-mobile');
  });

  test('cost empty/error states light', async ({ page }) => {
    await auditRoute(page, 'light', '/admin/costs', 'costs-empty-mobile', { emptyCosts: true });
    await auditRoute(page, 'light', '/admin/costs', 'costs-error-mobile', { errorCosts: true });
  });

  test('logs and errors dark/light with many rows', async ({ page }) => {
    await auditRoute(page, 'dark', '/admin/logs', 'logs-many-mobile');
    await auditRoute(page, 'light', '/admin/logs', 'logs-many-mobile');
    await auditRoute(page, 'dark', '/admin/errors', 'errors-many-mobile');
    await auditRoute(page, 'light', '/admin/errors', 'errors-many-mobile');
  });
});

test.describe('Admin Chrome Theme — Desktop (1280x800)', () => {
  test.skip(({ viewport }) => viewport?.width !== 1280, 'Desktop audit runs only on the 1280px project');

  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('cost dashboard dark and light', async ({ page }) => {
    await auditRoute(page, 'dark', '/admin/costs', 'costs-large-desktop');
    await auditRoute(page, 'light', '/admin/costs', 'costs-large-desktop');
  });

  test('logs/errors dark and light', async ({ page }) => {
    await auditRoute(page, 'dark', '/admin/logs', 'logs-many-desktop');
    await auditRoute(page, 'light', '/admin/logs', 'logs-many-desktop');
    await auditRoute(page, 'dark', '/admin/errors', 'errors-many-desktop');
    await auditRoute(page, 'light', '/admin/errors', 'errors-many-desktop');
  });
});
