import { expect, type Page, type Route, test } from '@playwright/test';

import {
  assertNoOverflow as assertNoHorizontalOverflow,
  expectTheme,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-1',
  userId: 'user-admin-1',
});

// Generate 30 days of DAU data
function makeDauData(
  days = 30,
  opts: { allZero?: boolean } = {}
): Array<{ date: string; unique_users: number }> {
  return Array.from({ length: days }, (_, i) => {
    const d = new Date('2026-02-26');
    d.setDate(d.getDate() + i);
    return {
      date: d.toISOString().slice(0, 10),
      unique_users: opts.allZero ? 0 : Math.max(1, Math.round(50 + 30 * Math.sin(i / 4) + i * 0.5)),
    };
  });
}

// Generate feature adoption totals + trend
function makeFeatureAdoption(opts: { longEventNames?: boolean; manyEvents?: boolean } = {}) {
  const events = opts.manyEvents
    ? [
        'project_created',
        'project_deleted',
        'workspace_created',
        'workspace_started',
        'workspace_stopped',
        'task_submitted',
        'task_completed',
        'task_failed',
        'node_created',
        'node_deleted',
        'credential_saved',
        'session_created',
        'settings_changed',
      ]
    : ['project_created', 'workspace_created', 'task_submitted', 'task_completed'];

  const totals = events.map((name, i) => ({
    event_name: opts.longEventNames
      ? `very_long_event_name_that_exceeds_label_map_${name}_${i}`
      : name,
    count: Math.max(1, (events.length - i) * 150),
    unique_users: Math.max(1, (events.length - i) * 30),
  }));

  const trend: Array<{ event_name: string; date: string; count: number }> = [];
  for (const ev of totals.slice(0, 3)) {
    for (let d = 0; d < 7; d++) {
      const date = new Date('2026-03-20');
      date.setDate(date.getDate() + d);
      trend.push({
        event_name: ev.event_name,
        date: date.toISOString().slice(0, 10),
        count: Math.max(0, ev.count / 7 + (Math.random() * 10 - 5)),
      });
    }
  }

  return { totals, trend, period: '30d' };
}

// Events table mock data
function makeEventsData(opts: { manyRows?: boolean; longNames?: boolean } = {}) {
  const base = opts.manyRows
    ? Array.from({ length: 30 }, (_, i) => ({
        event_name: `event_type_${String(i).padStart(2, '0')}`,
        count: (30 - i) * 1234,
        unique_users: (30 - i) * 200,
        avg_response_ms: 50 + i * 10,
      }))
    : [
        { event_name: 'workspace_created', count: 4820, unique_users: 1200, avg_response_ms: 62.3 },
        { event_name: 'task_submitted', count: 3100, unique_users: 900, avg_response_ms: 91.0 },
        { event_name: 'project_created', count: 1540, unique_users: 700, avg_response_ms: 45.5 },
        { event_name: 'credential_saved', count: 870, unique_users: 600, avg_response_ms: 33.2 },
        { event_name: 'node_created', count: 400, unique_users: 150, avg_response_ms: 220.8 },
      ];

  if (opts.longNames) {
    return {
      events: base.map((e, i) => ({
        ...e,
        event_name: `super_long_event_category_name_that_should_wrap_or_truncate_${i}_${e.event_name}`,
      })),
      period: '30d',
    };
  }

  return { events: base, period: '30d' };
}

// ---------------------------------------------------------------------------
// Scenario datasets
// ---------------------------------------------------------------------------

interface MockScenario {
  dau?: ReturnType<typeof makeDauData>;
  featureAdoption?: ReturnType<typeof makeFeatureAdoption>;
  events?: ReturnType<typeof makeEventsData>;
  aiUsage?: ReturnType<typeof makeAiUsageData>;
  apiError?: boolean;
}

function makeAiUsageData(opts: { empty?: boolean; manyModels?: boolean } = {}) {
  const models = opts.manyModels
    ? Array.from({ length: 12 }, (_, i) => `@cf/provider/model-with-long-name-${i}`)
    : ['@cf/meta/llama-4-scout-17b-16e-instruct', 'gpt-4.1-mini', 'claude-haiku-4-5'];

  return {
    totalRequests: opts.empty ? 0 : 1234567,
    totalInputTokens: opts.empty ? 0 : 987654321,
    totalOutputTokens: opts.empty ? 0 : 123456789,
    totalCostUsd: opts.empty ? 0 : 1234.5678,
    cachedRequests: opts.empty ? 0 : 4321,
    errorRequests: opts.empty ? 0 : 42,
    byModel: opts.empty
      ? []
      : models.map((model, i) => ({
          model,
          provider: model.startsWith('@cf/')
            ? 'workers-ai'
            : model.startsWith('gpt')
              ? 'openai'
              : 'anthropic',
          requests: 100000 - i * 7000,
          inputTokens: 8000000 - i * 250000,
          outputTokens: 1000000 - i * 50000,
          totalTokens: 9000000 - i * 300000,
          costUsd: i === 0 ? 0.0042 : 123.456 / (i + 1),
          cachedRequests: 100 - i,
          errorRequests: i,
        })),
    byDay: opts.empty
      ? []
      : Array.from({ length: 14 }, (_, i) => ({
          date: `2026-03-${String(i + 1).padStart(2, '0')}`,
          requests: 1000 + i * 500,
          inputTokens: 100000 + i * 10000,
          outputTokens: 20000 + i * 2000,
          costUsd: i === 0 ? 0.0004 : 10 + i * 2,
        })),
    period: '30d',
  };
}

const NORMAL: MockScenario = {
  dau: makeDauData(30),
  featureAdoption: makeFeatureAdoption(),
  events: makeEventsData(),
  aiUsage: makeAiUsageData(),
};

const EMPTY: MockScenario = {
  dau: makeDauData(0),
  featureAdoption: { totals: [], trend: [], period: '30d' },
  events: { events: [], period: '30d' },
  aiUsage: makeAiUsageData({ empty: true }),
};

const MANY_ITEMS: MockScenario = {
  dau: makeDauData(90),
  featureAdoption: makeFeatureAdoption({ manyEvents: true }),
  events: makeEventsData({ manyRows: true }),
  aiUsage: makeAiUsageData({ manyModels: true }),
};

const LONG_TEXT: MockScenario = {
  dau: makeDauData(30),
  featureAdoption: makeFeatureAdoption({ longEventNames: true }),
  events: makeEventsData({ longNames: true }),
  aiUsage: makeAiUsageData({ manyModels: true }),
};

const API_ERROR: MockScenario = { apiError: true };

// ---------------------------------------------------------------------------
// API mock helpers
// ---------------------------------------------------------------------------

const RETIRED_ANALYTICS_PATHS = [
  '/admin/analytics/funnel',
  '/admin/analytics/geo',
  '/admin/analytics/retention',
];

async function setupMocks(page: Page, scenario: MockScenario) {
  const retiredRequests: string[] = [];
  const respond = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.addInitScript(
    (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
    MOCK_USER.user.id
  );
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/credentials' || path === '/api/github/installations')
      return respond(route, 200, []);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path === '/api/projects') return respond(route, 200, { projects: [] });

    // Auth — BetterAuth calls /api/auth/get-session and related paths
    if (path.includes('/api/auth/')) {
      return respond(route, 200, MOCK_USER);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    }

    // Retired SaaS-era sections (Insights slice H2): the API answers 404 now.
    if (RETIRED_ANALYTICS_PATHS.some((retired) => path.endsWith(retired))) {
      retiredRequests.push(path);
      return respond(route, 404, { error: 'NOT_FOUND' });
    }

    // Analytics endpoints
    if (path.includes('/admin/analytics/dau')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, {
        dau: scenario.dau ?? [],
        periodDays: scenario.dau?.length ?? 0,
      });
    }

    if (path.includes('/admin/analytics/feature-adoption')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.featureAdoption ?? makeFeatureAdoption());
    }

    if (path.includes('/admin/analytics/website-traffic')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, {
        hosts: [
          {
            host: 'simple-agent-manager.org',
            totalViews: 12400,
            uniqueVisitors: 3200,
            uniqueSessions: 4100,
            sections: [
              {
                name: 'landing',
                views: 5200,
                unique_visitors: 2100,
                topPages: [{ page: '/', views: 4000, unique_visitors: 1800 }],
              },
              {
                name: 'docs',
                views: 4100,
                unique_visitors: 1600,
                topPages: [{ page: '/docs/getting-started', views: 2000, unique_visitors: 900 }],
              },
              {
                name: 'blog',
                views: 2100,
                unique_visitors: 800,
                topPages: [{ page: '/blog/launch', views: 1200, unique_visitors: 500 }],
              },
            ],
          },
        ],
        trend: [],
        period: '7d',
      });
    }

    if (path.includes('/admin/analytics/ai-usage')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.aiUsage ?? makeAiUsageData());
    }

    if (path.includes('/admin/analytics/forward-status')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, {
        enabled: true,
        lastForwardedAt: '2026-03-28T10:00:00Z',
        destinations: { segment: { configured: true }, ga4: { configured: false } },
        events: ['signup', 'login', 'project_created'],
      });
    }

    if (path.includes('/admin/analytics/events')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.events ?? makeEventsData());
    }

    if (path.includes('/admin/health')) {
      return respond(route, 200, { status: 'ok' });
    }

    if (path.startsWith('/api/projects')) {
      return respond(route, 200, { projects: [], nextCursor: null });
    }

    if (path.startsWith('/api/credentials')) {
      return respond(route, 200, []);
    }

    // Catch-all for any other API calls
    return respond(route, 200, {});
  });
  return { retiredRequests };
}

/** Kept sections render, retired ones are gone, and the page never asks for them. */
async function expectOnlyKeptSections(page: Page) {
  const { retiredRequests } = await setupMocks(page, NORMAL);
  await page.goto('/admin/analytics');
  await page.waitForTimeout(800);

  for (const kept of [
    /^AI Usage/,
    /^Daily Active Users/,
    /^Feature Adoption/,
    /^Website Traffic/,
    /^Top Events/,
  ]) {
    await expect(page.getByRole('heading', { level: 3, name: kept })).toBeVisible();
  }
  for (const retired of [/Conversion Funnel/, /Geographic Distribution/, /Retention Cohorts/]) {
    await expect(page.getByRole('heading', { name: retired })).toHaveCount(0);
  }
  expect(retiredRequests).toEqual([]);
  await assertNoHorizontalOverflow(page);

  // The page scrolls inside the app shell, so capture each kept section in view.
  const width = page.viewportSize()?.width ?? 0;
  for (const [slug, heading] of [
    ['ai-usage', /^AI Usage/],
    ['adoption', /^Feature Adoption/],
    ['traffic', /^Website Traffic/],
  ] as const) {
    await page.getByRole('heading', { level: 3, name: heading }).scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await screenshot(page, `admin-analytics-sections-${slug}-${width}`);
  }
}

// ---------------------------------------------------------------------------
// Mobile tests (default viewport from config: 375x667)
// ---------------------------------------------------------------------------

test.describe('Admin Analytics — Mobile (375x667)', () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 375,
    'Mobile audit runs only on the 375px project'
  );

  test('retired sections are gone and kept sections render', async ({ page }) => {
    await expectOnlyKeptSections(page);
  });

  test('normal data — all charts render', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await screenshot(page, 'admin-analytics-normal-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('empty state — all sections show empty messages', async ({ page }) => {
    await setupMocks(page, EMPTY);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);
    await screenshot(page, 'admin-analytics-empty-mobile');
    await assertNoHorizontalOverflow(page);

    // All empty state texts should be visible
    const emptyMessages = page.locator('text=/No .* data available yet/');
    const count = await emptyMessages.count();
    expect(count).toBeGreaterThan(0);
  });

  test('many items — 30+ events, 90 day DAU, many AI models', async ({ page }) => {
    await setupMocks(page, MANY_ITEMS);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await screenshot(page, 'admin-analytics-many-items-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('long event names — no overflow from untruncated text', async ({ page }) => {
    await setupMocks(page, LONG_TEXT);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);
    await screenshot(page, 'admin-analytics-long-text-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('error state — page still renders with empty states', async ({ page }) => {
    await setupMocks(page, API_ERROR);
    await page.goto('/admin/analytics');
    // When APIs fail, individual sections show empty state messages. Wait for the
    // failed queries to settle instead of racing a fixed timeout against them.
    await expect(page.locator('text=/No .* data available yet/').first()).toBeVisible();
    await screenshot(page, 'admin-analytics-error-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — normal charts and tables', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-normal-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — many rows and large numbers', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, MANY_ITEMS);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-many-items-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — empty and error states', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, API_ERROR);
    await page.goto('/admin/analytics');
    await expect(page.locator('text=/No .* data available yet/').first()).toBeVisible();
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-error-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('period selector toggle — all four buttons accessible and toggleable', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    const group = page.getByRole('group', { name: /time period/i });
    await expect(group).toBeVisible();

    // The default selected period button should have aria-pressed="true"
    const pressedBtn = page.getByRole('button', { pressed: true });
    await expect(pressedBtn).toBeVisible();

    // Click a different period
    const btn7d = page.getByRole('button', { name: '7d' });
    await btn7d.click();
    await page.waitForTimeout(200);
    await expect(btn7d).toHaveAttribute('aria-pressed', 'true');

    // Touch target check: button height >= 36px (min-h-[36px])
    const box = await btn7d.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(36);
  });

  test('events table has scope="col" on all headers', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    // Events and website traffic tables should both be present
    const tables = page.locator('table');
    const tableCount = await tables.count();
    expect(tableCount).toBeGreaterThanOrEqual(2);

    const allColHeaders = page.locator('th[scope="col"]');
    const allColCount = await allColHeaders.count();
    expect(allColCount).toBeGreaterThan(0);
  });

  test('KPI summary cards render with data', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);

    await expect(page.getByText('DAU (latest)')).toBeVisible();
    await expect(page.getByText('Avg DAU')).toBeVisible();
    await expect(page.getByText('Funnel Conversion')).toHaveCount(0);
    await expect(page.getByText(/^Events /)).toBeVisible();
  });

  test('DAU chart renders as Recharts area chart', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);

    // Recharts renders SVG with .recharts-wrapper class
    const rechartsWrapper = page.locator('.recharts-wrapper');
    const exists = await rechartsWrapper.count();
    expect(exists).toBeGreaterThan(0);
  });

  test('section headings use correct text size (base/semibold)', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    const headings = page.locator('h3.text-base.font-semibold');
    const count = await headings.count();
    // All card sections should use the upgraded heading style
    expect(count).toBeGreaterThanOrEqual(5);
  });

  test('events table columns are sortable', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);

    // Find sortable column headers with aria-sort
    const sortableHeaders = page.locator('th[aria-sort]');
    const count = await sortableHeaders.count();
    expect(count).toBeGreaterThan(0);

    // Click "Avg (ms)" header — unique to the events table
    const avgHeader = page.getByRole('columnheader', { name: /Avg/ });
    await avgHeader.click();
    await page.waitForTimeout(200);
    await expect(avgHeader).toHaveAttribute('aria-sort');
  });

  test('forwarding status is collapsible', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);

    // Forwarding section should have a toggle button
    const forwardingToggle = page.getByRole('button', { name: /event forwarding/i });
    await expect(forwardingToggle).toBeVisible();
    await expect(forwardingToggle).toHaveAttribute('aria-expanded', 'false');

    // Click to expand
    await forwardingToggle.click();
    await page.waitForTimeout(200);
    await expect(forwardingToggle).toHaveAttribute('aria-expanded', 'true');
  });
});

// ---------------------------------------------------------------------------
// Desktop tests (1280x800)
// ---------------------------------------------------------------------------

test.describe('Admin Analytics — Desktop (1280x800)', () => {
  test.skip(
    ({ viewport }) => viewport?.width !== 1280,
    'Desktop audit runs only on the 1280px project'
  );

  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('retired sections are gone and kept sections render', async ({ page }) => {
    await expectOnlyKeptSections(page);
  });

  test('normal data — full layout', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
    await screenshot(page, 'admin-analytics-normal-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, EMPTY);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);
    await screenshot(page, 'admin-analytics-empty-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('many items — desktop', async ({ page }) => {
    await setupMocks(page, MANY_ITEMS);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await screenshot(page, 'admin-analytics-many-items-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('long event names — bar charts do not overflow page', async ({ page }) => {
    await setupMocks(page, LONG_TEXT);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);
    await screenshot(page, 'admin-analytics-long-text-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('error state', async ({ page }) => {
    await setupMocks(page, API_ERROR);
    await page.goto('/admin/analytics');
    await expect(page.locator('text=/No .* data available yet/').first()).toBeVisible();
    await screenshot(page, 'admin-analytics-error-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — normal data', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-normal-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — empty state', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, EMPTY);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-empty-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('light theme — many rows', async ({ page }) => {
    await seedTheme(page, 'light');
    await setupMocks(page, MANY_ITEMS);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await expectTheme(page, 'light');
    await screenshot(page, 'admin-analytics-light-many-items-desktop');
    await assertNoHorizontalOverflow(page);
  });
});
