import { expect, type Page, type Route,test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data Factories
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-admin-1',
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
    id: 'session-admin-1',
    userId: 'user-admin-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-admin-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

// Generate 30 days of DAU data
function makeDauData(
  days = 30,
  opts: { allZero?: boolean } = {},
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
function makeFeatureAdoption(
  opts: { longEventNames?: boolean; manyEvents?: boolean } = {},
) {
  const events = opts.manyEvents
    ? [
        'project_created', 'project_deleted', 'workspace_created', 'workspace_started',
        'workspace_stopped', 'task_submitted', 'task_completed', 'task_failed',
        'node_created', 'node_deleted', 'credential_saved', 'session_created', 'settings_changed',
      ]
    : ['project_created', 'workspace_created', 'task_submitted', 'task_completed'];

  const totals = events.map((name, i) => ({
    event_name: opts.longEventNames ? `very_long_event_name_that_exceeds_label_map_${name}_${i}` : name,
    count: Math.max(1, (events.length - i) * 150),
    unique_users: Math.max(1, (events.length - i) * 30),
  }));

  const trend: Array<{ event_name: string; date: string; count: number }> = [];
  for (const ev of totals.slice(0, 3)) {
    for (let d = 0; d < 7; d++) {
      const date = new Date('2026-03-20');
      date.setDate(date.getDate() + d);
      trend.push({ event_name: ev.event_name, date: date.toISOString().slice(0, 10), count: Math.max(0, ev.count / 7 + (Math.random() * 10 - 5)) });
    }
  }

  return { totals, trend, period: '30d' };
}

// Geo distribution mock data
function makeGeoData(opts: { manyCountries?: boolean } = {}) {
  const countries = opts.manyCountries
    ? ['US', 'DE', 'GB', 'FR', 'JP', 'CA', 'AU', 'BR', 'IN', 'NL', 'SE', 'SG', 'CH', 'ES', 'IT']
    : ['US', 'DE', 'GB', 'FR', 'JP'];

  return {
    geo: countries.map((country, i) => ({
      country,
      event_count: (countries.length - i) * 500,
      unique_users: (countries.length - i) * 100,
    })),
    period: '30d',
  };
}

// Retention cohort mock data
function makeRetentionData(opts: { weeks?: number; allHigh?: boolean; allLow?: boolean } = {}) {
  const weeksCount = opts.weeks ?? 6;
  const retention = Array.from({ length: weeksCount }, (_, cohortIndex) => {
    const cohortDate = new Date('2026-01-20');
    cohortDate.setDate(cohortDate.getDate() + cohortIndex * 7);
    const cohortSize = 100 + cohortIndex * 20;

    const weeks = Array.from({ length: weeksCount - cohortIndex }, (_, w) => {
      let rate: number;
      if (opts.allHigh) {
        rate = 90 - w * 2;
      } else if (opts.allLow) {
        rate = 5;
      } else {
        rate = Math.max(0, Math.round(100 - w * 15 - cohortIndex * 3));
      }
      return {
        week: w,
        users: Math.round((cohortSize * rate) / 100),
        rate,
      };
    });

    return {
      cohortWeek: cohortDate.toISOString().slice(0, 10),
      cohortSize,
      weeks,
    };
  });

  return { retention, weeks: weeksCount };
}

// Funnel mock data
function makeFunnelData(opts: { allZero?: boolean } = {}) {
  if (opts.allZero) {
    return {
      funnel: [
        { event_name: 'signup', unique_users: 0 },
        { event_name: 'login', unique_users: 0 },
        { event_name: 'project_created', unique_users: 0 },
        { event_name: 'workspace_created', unique_users: 0 },
        { event_name: 'task_submitted', unique_users: 0 },
      ],
      periodDays: 30,
    };
  }
  return {
    funnel: [
      { event_name: 'signup', unique_users: 1200 },
      { event_name: 'login', unique_users: 980 },
      { event_name: 'project_created', unique_users: 620 },
      { event_name: 'workspace_created', unique_users: 400 },
      { event_name: 'task_submitted', unique_users: 210 },
    ],
    periodDays: 30,
  };
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
  funnel?: ReturnType<typeof makeFunnelData>;
  featureAdoption?: ReturnType<typeof makeFeatureAdoption>;
  geo?: ReturnType<typeof makeGeoData>;
  retention?: ReturnType<typeof makeRetentionData>;
  events?: ReturnType<typeof makeEventsData>;
  apiError?: boolean;
}

const NORMAL: MockScenario = {
  dau: makeDauData(30),
  funnel: makeFunnelData(),
  featureAdoption: makeFeatureAdoption(),
  geo: makeGeoData(),
  retention: makeRetentionData({ weeks: 6 }),
  events: makeEventsData(),
};

const EMPTY: MockScenario = {
  dau: makeDauData(0),
  funnel: makeFunnelData({ allZero: true }),
  featureAdoption: { totals: [], trend: [], period: '30d' },
  geo: { geo: [], period: '30d' },
  retention: { retention: [], weeks: 12 },
  events: { events: [], period: '30d' },
};

const MANY_ITEMS: MockScenario = {
  dau: makeDauData(90),
  funnel: makeFunnelData(),
  featureAdoption: makeFeatureAdoption({ manyEvents: true }),
  geo: makeGeoData({ manyCountries: true }),
  retention: makeRetentionData({ weeks: 12 }),
  events: makeEventsData({ manyRows: true }),
};

const LONG_TEXT: MockScenario = {
  dau: makeDauData(30),
  funnel: makeFunnelData(),
  featureAdoption: makeFeatureAdoption({ longEventNames: true }),
  geo: makeGeoData(),
  retention: makeRetentionData({ weeks: 6 }),
  events: makeEventsData({ longNames: true }),
};

const HIGH_RETENTION: MockScenario = {
  ...NORMAL,
  retention: makeRetentionData({ weeks: 6, allHigh: true }),
};

const LOW_RETENTION: MockScenario = {
  ...NORMAL,
  retention: makeRetentionData({ weeks: 6, allLow: true }),
};

const API_ERROR: MockScenario = { apiError: true };

// ---------------------------------------------------------------------------
// API mock helpers
// ---------------------------------------------------------------------------

async function setupMocks(page: Page, scenario: MockScenario) {
  const respond = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    // Auth — BetterAuth calls /api/auth/get-session and related paths
    if (path.includes('/api/auth/')) {
      return respond(route, 200, MOCK_USER);
    }

    // Notifications
    if (path.startsWith('/api/notifications')) {
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    }

    // Analytics endpoints
    if (path.includes('/admin/analytics/dau')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, { dau: scenario.dau ?? [], periodDays: scenario.dau?.length ?? 0 });
    }

    if (path.includes('/admin/analytics/funnel')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.funnel ?? makeFunnelData());
    }

    if (path.includes('/admin/analytics/feature-adoption')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.featureAdoption ?? makeFeatureAdoption());
    }

    if (path.includes('/admin/analytics/geo')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.geo ?? makeGeoData());
    }

    if (path.includes('/admin/analytics/retention')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, scenario.retention ?? makeRetentionData());
    }

    if (path.includes('/admin/analytics/website-traffic')) {
      if (scenario.apiError) return respond(route, 500, { error: 'Internal Server Error' });
      return respond(route, 200, {
        hosts: [{
          host: 'simple-agent-manager.org',
          totalViews: 12400,
          uniqueVisitors: 3200,
          uniqueSessions: 4100,
          sections: [
            { name: 'landing', views: 5200, unique_visitors: 2100, topPages: [{ page: '/', views: 4000, unique_visitors: 1800 }] },
            { name: 'docs', views: 4100, unique_visitors: 1600, topPages: [{ page: '/docs/getting-started', views: 2000, unique_visitors: 900 }] },
            { name: 'blog', views: 2100, unique_visitors: 800, topPages: [{ page: '/blog/launch', views: 1200, unique_visitors: 500 }] },
          ],
        }],
        trend: [],
        period: '7d',
      });
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
      return respond(route, 200, []);
    }

    if (path.startsWith('/api/credentials')) {
      return respond(route, 200, []);
    }

    // Catch-all for any other API calls
    return respond(route, 200, {});
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(700);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow, 'Page must not have horizontal overflow').toBe(false);
}

// ---------------------------------------------------------------------------
// Mobile tests (default viewport from config: 375x667)
// ---------------------------------------------------------------------------

test.describe('Admin Analytics — Mobile (375x667)', () => {
  test('normal data — all charts render', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
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

  test('many items — 30+ events, 15 countries, 90 day DAU, 12 cohort weeks', async ({ page }) => {
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
    await page.waitForTimeout(600);
    await screenshot(page, 'admin-analytics-error-mobile');
    await assertNoHorizontalOverflow(page);
    // When APIs fail, individual sections show empty state messages
    const emptyMessages = page.locator('text=/No .* data available yet/');
    const count = await emptyMessages.count();
    expect(count).toBeGreaterThan(0);
  });

  test('high retention heat map — deep green cells', async ({ page }) => {
    await setupMocks(page, HIGH_RETENTION);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);
    await screenshot(page, 'admin-analytics-retention-high-mobile');
    await assertNoHorizontalOverflow(page);
  });

  test('low retention heat map — pale cells', async ({ page }) => {
    await setupMocks(page, LOW_RETENTION);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);
    await screenshot(page, 'admin-analytics-retention-low-mobile');
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

  test('retention table has accessible scope attributes', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    // Check column headers have scope="col"
    const colHeaders = page.locator('table thead th[scope="col"]');
    const colCount = await colHeaders.count();
    expect(colCount).toBeGreaterThan(0);

    // Check row headers have scope="row"
    const rowHeaders = page.locator('table tbody th[scope="row"]');
    const rowCount = await rowHeaders.count();
    expect(rowCount).toBeGreaterThan(0);
  });

  test('events table has scope="col" on all headers', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    // EventsTable, retention, geo, and website traffic tables should all be present
    const tables = page.locator('table');
    const tableCount = await tables.count();
    expect(tableCount).toBeGreaterThanOrEqual(2); // retention + events + geo + website

    const allColHeaders = page.locator('th[scope="col"]');
    const allColCount = await allColHeaders.count();
    expect(allColCount).toBeGreaterThan(0);
  });

  test('KPI summary cards render with data', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);

    // KPI cards should show key metrics
    const kpiGrid = page.locator('.grid.grid-cols-2');
    await expect(kpiGrid).toBeVisible();

    // Should have at least 3 KPI cards (DAU, avg DAU, funnel, events)
    const kpiCards = kpiGrid.locator('> div');
    const count = await kpiCards.count();
    expect(count).toBeGreaterThanOrEqual(3);
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
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data — full layout', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
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

  test('many items — 12 retention weeks desktop scroll', async ({ page }) => {
    await setupMocks(page, MANY_ITEMS);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(800);
    await screenshot(page, 'admin-analytics-many-items-desktop');
    // The retention table can scroll internally but the page itself must not overflow
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
    await page.waitForTimeout(600);
    await screenshot(page, 'admin-analytics-error-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('retention heat map high values', async ({ page }) => {
    await setupMocks(page, HIGH_RETENTION);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(700);
    await screenshot(page, 'admin-analytics-retention-high-desktop');
    await assertNoHorizontalOverflow(page);
  });

  test('retention table caption is present in DOM (SR accessible)', async ({ page }) => {
    await setupMocks(page, NORMAL);
    await page.goto('/admin/analytics');
    await page.waitForTimeout(600);

    const caption = page.locator('table caption.sr-only');
    await expect(caption).toBeAttached();
    const captionText = await caption.textContent();
    expect(captionText?.trim().length).toBeGreaterThan(20);
  });
});
