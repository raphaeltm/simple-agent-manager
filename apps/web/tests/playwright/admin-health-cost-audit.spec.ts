/**
 * Visual audit for Admin › Spend and health › Health & cost (Insights slice H) at 375 and 1280,
 * with normal, stress (long reasons, many weeks and reasons, 11 latency states), empty,
 * partially unavailable, and error data. Asserts no overflow (including clipped overflow) and
 * that the page root fits the viewport.
 */
import { expect, type Page, type Route, test } from '@playwright/test';
import type { InstallationHealthResponse } from '@simple-agent-manager/shared';

import {
  assertNoOverflow,
  expectTheme,
  makeMockUser,
  screenshot,
  seedTheme,
} from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'admin@example.com',
  name: 'Admin User',
  role: 'superadmin',
  sessionId: 'session-admin-health-1',
  userId: 'admin-health-1',
});

const STATES = [
  ['workspace', 'pending', 15],
  ['workspace', 'creating', 15],
  ['workspace', 'recovery', 15],
  ['workspace', 'stopping', 10],
  ['node', 'pending', 15],
  ['node', 'creating', 15],
  ['node', 'recovery', 15],
  ['node', 'stopping', 20],
  ['session_sleep', 'preparing', 15],
  ['session_sleep', 'stopping', 15],
  ['session_recovery', 'waking', 15],
] as const;

const LONG_REASON =
  'measured memory headroom would be exceeded after outstanding reservations on a host whose observed hardware differs from its planned offering ' +
  'https://example.com/a/really/long/unbroken/path/that/keeps/going/and/going/without/any/spaces/at/all';

const LONG_ERROR =
  'Cloudflare GraphQL error: cannot request data older than 4w4d, but your query requests data from 6w4d22h36m8s ago; ' +
  'https://developers.cloudflare.com/analytics/graphql-api/limits/and/a/very/long/unbroken/path/that/never/wraps/by/itself';

type CloudflareCard = NonNullable<InstallationHealthResponse['cloudflare']>;

function makeCloudflare(kind: 'normal' | 'stress' | 'empty'): CloudflareCard {
  if (kind === 'empty')
    return {
      status: 'never_run',
      lastAttemptAt: null,
      lastSuccessAt: null,
      error: null,
      month: null,
      throughDay: null,
      monthComplete: false,
      missingDays: 0,
      monthToDateUsd: 0,
      projectedUsd: 0,
      productLines: [],
      otherProductLines: { count: 0, monthToDateUsd: 0, projectedUsd: 0 },
      daily: [],
    };
  const scale = kind === 'stress' ? 1000 : 1;
  const lines = [
    ['doRowsWritten', 'Durable Objects', 'Durable Objects SQLite rows written', 4.2, 9.39],
    ['workersAiNeurons', 'Workers AI', 'Workers AI neurons', 1.6, 3.4],
    ['r2StorageGb', 'R2', 'R2 storage', 1.3, 2.47],
    ['containerMemoryGibSeconds', 'Containers', 'Containers memory', 0.4, 1.41],
    ['doStorageReadUnits', 'Durable Objects', 'Durable Objects KV read units', 0.3, 1.08],
  ] as const;
  return {
    status: kind === 'stress' ? 'error' : 'ok',
    lastAttemptAt: '2026-11-16T03:00:05.000Z',
    lastSuccessAt: '2026-11-15T03:00:04.000Z',
    error: kind === 'stress' ? LONG_ERROR : null,
    month: '2026-11',
    throughDay: '2026-11-15',
    monthComplete: false,
    missingDays: kind === 'stress' ? 4 : 0,
    monthToDateUsd: 8.41 * scale,
    projectedUsd: 20.76 * scale,
    productLines: lines.map(([key, product, label, mtd, projected]) => ({
      key,
      product,
      label,
      unit: 'units',
      monthToDateUsage: 1,
      monthToDateUsd: mtd * scale,
      projectedUsd: projected * scale,
    })),
    otherProductLines: { count: 14, monthToDateUsd: 0.61 * scale, projectedUsd: 3.01 * scale },
    daily: Array.from({ length: kind === 'stress' ? 62 : 30 }, (_, i) => ({
      day: new Date(Date.UTC(2026, 10, 15 - (kind === 'stress' ? 61 : 29) + i))
        .toISOString()
        .slice(0, 10),
      costUsd: kind === 'stress' && i % 9 === 3 ? null : (0.3 + ((i * 7) % 11) / 10) * scale,
    })),
  };
}

function makeHealth(kind: 'normal' | 'stress' | 'empty'): InstallationHealthResponse {
  const weekCount = kind === 'stress' ? 26 : 6;
  const weekStart = (i: number) => new Date(Date.UTC(2026, 9, 5 + i * 7)).toISOString();
  // Hetzner prices in EUR and GCP in USD, as in production: one chart per currency.
  const eurWeeks = Array.from({ length: weekCount }, (_, i) => {
    const hetzner = 50 + i * 3;
    return {
      weekStart: weekStart(i),
      total: hetzner,
      byProvider: [{ provider: 'hetzner', amount: hetzner }],
    };
  });
  const usdWeeks = Array.from({ length: weekCount }, (_, i) => {
    const gcp = 10 + (i % 3) * 9;
    const extra = kind === 'stress' ? [{ provider: 'digitalocean', amount: 4.2 }] : [];
    return {
      weekStart: weekStart(i),
      total: gcp + (kind === 'stress' ? 4.2 : 0),
      byProvider: [{ provider: 'gcp', amount: gcp }, ...extra],
    };
  });
  return {
    window: { range: 'month', start: '2026-11-01T00:00:00.000Z', end: '2026-11-16T12:00:00.000Z' },
    generatedAt: '2026-11-16T12:00:00.000Z',
    compute:
      kind === 'empty'
        ? { currencies: [], unpricedNodes: 0, nodes: 0, truncated: false }
        : {
            currencies: [
              {
                currency: 'EUR',
                total: kind === 'stress' ? 98765.43 : 291.2,
                byProvider: [
                  {
                    provider: 'hetzner',
                    amount: kind === 'stress' ? 98765.43 : 291.2,
                    nodeHours: 30000,
                    nodes: 240,
                  },
                ],
                weeks: eurWeeks,
              },
              {
                currency: 'USD',
                total: kind === 'stress' ? 24691.36 : 121.2,
                byProvider: [
                  {
                    provider: 'gcp',
                    amount: kind === 'stress' ? 24691.35 : 121.2,
                    nodeHours: 3000,
                    nodes: 47,
                  },
                  ...(kind === 'stress'
                    ? [{ provider: 'digitalocean', amount: 0.01, nodeHours: 1, nodes: 1 }]
                    : []),
                ],
                weeks: usdWeeks,
              },
            ],
            unpricedNodes: kind === 'stress' ? 12 : 0,
            nodes: 288,
            truncated: kind === 'stress',
          },
    reuse:
      kind === 'empty'
        ? {
            placements: 0,
            onExistingMachine: 0,
            onNewMachine: 0,
            fromWarmPool: 0,
            reuseRate: null,
            weeks: [],
            truncated: false,
          }
        : {
            placements: 2254,
            onExistingMachine: 1974,
            onNewMachine: 280,
            fromWarmPool: 72,
            reuseRate: 0.876,
            weeks: eurWeeks.map((w, i) => ({
              weekStart: w.weekStart,
              placements: 300,
              reuseRate: 0.6 + (i % 4) * 0.08,
            })),
            truncated: false,
          },
    density:
      kind === 'empty'
        ? {
            agentsPerBusyMachine: null,
            busyMachineHours: 0,
            agentHours: 0,
            peakAgentsOnOneMachine: 0,
            machines: 0,
            runs: 0,
            truncated: false,
          }
        : {
            agentsPerBusyMachine: 2.43,
            busyMachineHours: 12345.6,
            agentHours: 30000,
            peakAgentsOnOneMachine: 9,
            machines: 120,
            runs: 2233,
            truncated: false,
          },
    newMachines:
      kind === 'empty'
        ? { newMachines: 0, reasons: [], otherReasons: 0 }
        : {
            newMachines: 280,
            reasons: [
              { reason: 'Host agent version is incompatible', kind: 'refused', machines: 120 },
              {
                reason: 'disk reservation budget would be exceeded',
                kind: 'refused',
                machines: 98,
              },
              { reason: 'No other machine in the pool to try', kind: 'no_candidate', machines: 26 },
              { reason: 'Placement explanation not recorded', kind: 'not_recorded', machines: 4 },
              ...(kind === 'stress'
                ? [
                    { reason: LONG_REASON, kind: 'refused' as const, machines: 3 },
                    ...Array.from({ length: 30 }, (_, i) => ({
                      reason: `<script>alert(${i})</script> refusal reason ${i} ✓ 日本語`,
                      kind: 'refused' as const,
                      machines: 30 - i,
                    })),
                  ]
                : []),
            ],
            otherReasons: kind === 'stress' ? 17 : 0,
          },
    latency: {
      minSamples: 5,
      states: STATES.map(([entityType, status, budgetMinutes], i) => {
        const empty = kind === 'empty' || i % 4 === 2;
        const slow = kind !== 'empty' && entityType === 'workspace' && status === 'stopping';
        const p95 = slow ? 31 * 60_000 : (i + 1) * 23_000;
        return {
          entityType,
          status,
          budgetMs: budgetMinutes * 60_000,
          count: empty ? 0 : 40,
          p50Ms: empty ? null : p95 / 2,
          p95Ms: empty ? null : p95,
          maxMs: empty ? null : p95 * 2,
          truncated: false,
          overBudget: slow,
          overBudgetNow: slow ? 14 : 0,
          incidents: slow
            ? [
                {
                  signature: 'sig-1',
                  state: 'pending',
                  firstSeenAt: '2026-11-16T09:12:00.000Z',
                  lastSeenAt: '2026-11-16T11:00:00.000Z',
                  occurrences: 42,
                  ideaId: 'idea-1',
                  ideaProjectId: 'ops-project',
                },
              ]
            : [],
        };
      }),
    },
    cloudflare: makeCloudflare(kind),
    unavailable: [],
  };
}

type Scenario = { health?: InstallationHealthResponse; status?: number };

async function setupMocks(page: Page, scenario: Scenario) {
  const respond = (route: Route, status: number, body: unknown) =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.addInitScript(
    (id) => localStorage.setItem(`sam-onboarding-wizard-dismissed-${id}`, 'true'),
    MOCK_USER.user.id
  );
  await page.routeWebSocket('**/api/notifications/ws', () => undefined);
  await page.route('**/api/**', async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/health-cost/cloudflare/refresh')
      return respond(route, 200, {
        status: 'ok',
        firstDay: '2026-10-17',
        lastDay: '2026-11-15',
        rowsWritten: 570,
        error: null,
      });
    if (path === '/api/admin/health-cost') {
      if (scenario.status && scenario.status >= 400)
        return respond(route, scenario.status, {
          error: 'INTERNAL_ERROR',
          message: 'Health read failed',
        });
      return respond(route, 200, scenario.health);
    }
    if (path === '/api/credentials' || path === '/api/github/installations')
      return respond(route, 200, []);
    if (path === '/api/credentials/agent') return respond(route, 200, { credentials: [] });
    if (path.includes('/api/auth/')) return respond(route, 200, MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond(route, 200, { notifications: [], unreadCount: 0 });
    if (path.startsWith('/api/projects'))
      return respond(route, 200, { projects: [], nextCursor: null });
    return respond(route, 200, {});
  });
}

async function audit(
  page: Page,
  name: string,
  scenario: Scenario,
  theme: 'dark' | 'light' = 'dark'
) {
  await seedTheme(page, theme);
  await setupMocks(page, scenario);
  await page.goto('/admin/health-cost');
  await page.waitForTimeout(900);
  await expectTheme(page, theme);
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: /Health & cost/ })).toBeVisible();
  await screenshot(page, `admin-health-cost-${name}-${theme}`);
  // The page scrolls inside the app shell, so a viewport shot misses the lower panes: capture each.
  for (const pane of ['latency-pane', 'spend-pane', 'reasons-pane', 'cloudflare-pane']) {
    const locator = page.getByTestId(pane);
    if ((await locator.count()) === 0) continue;
    await locator.scrollIntoViewIfNeeded();
    await locator.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/admin-health-cost-${name}-${theme}-${pane}.png`,
    });
  }
  await assertNoOverflow(page);
  // The Cloudflare card is taller than a phone screen: capture it whole in a tall viewport too,
  // so its lower half (daily series, Refresh now) is reviewed at the phone's width.
  const cloudflarePane = page.getByTestId('cloudflare-pane');
  if ((await cloudflarePane.count()) > 0) {
    const size = page.viewportSize();
    if (size) {
      await page.setViewportSize({ width: size.width, height: 2000 });
      await cloudflarePane.scrollIntoViewIfNeeded();
      await cloudflarePane.screenshot({
        path: `../../.codex/tmp/playwright-screenshots/admin-health-cost-${name}-${theme}-cloudflare-pane-full.png`,
      });
      await page.setViewportSize(size);
    }
  }
  const fits = await page.evaluate(() => {
    const root = document.querySelector('[data-testid="admin-health-cost"]');
    return root ? root.getBoundingClientRect().right <= window.innerWidth + 1 : false;
  });
  expect(fits).toBe(true);
}

for (const viewport of [
  { label: 'mobile', width: 375, height: 667, isMobile: true },
  { label: 'desktop', width: 1280, height: 800, isMobile: false },
] as const) {
  test.describe(`Admin Health & cost — ${viewport.label}`, () => {
    // Keyed on the project, not the viewport fixture, which `test.use` below overrides.
    test.beforeEach(({ browserName: _browserName }, testInfo) => {
      test.skip(
        !testInfo.project.name.includes(`${viewport.width}x${viewport.height}`),
        `${viewport.label} audit runs only on the ${viewport.width}px project`
      );
    });
    test.use({
      viewport: { width: viewport.width, height: viewport.height },
      isMobile: viewport.isMobile,
    });

    test('normal data, dark and light, with the grouped admin nav', async ({ page }) => {
      await audit(page, `normal-${viewport.label}`, { health: makeHealth('normal') });
      await expect(
        page.getByTestId('tabs-group-label').filter({ hasText: 'Spend and health' })
      ).toHaveCount(1);
      await expect(page.getByRole('tab', { name: 'Health & cost' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      await expect(page.getByRole('link', { name: 'Open incident' })).toHaveAttribute(
        'href',
        '/projects/ops-project/ideas/idea-1'
      );
      await audit(page, `normal-${viewport.label}`, { health: makeHealth('normal') }, 'light');
    });

    test('stress data: long reasons, many weeks and reasons', async ({ page }) => {
      await audit(page, `stress-${viewport.label}`, { health: makeHealth('stress') });
      await expect(
        page.getByText('<script>alert(0)</script> refusal reason 0 ✓ 日本語')
      ).toBeVisible();
    });

    test('empty installation', async ({ page }) => {
      await audit(page, `empty-${viewport.label}`, { health: makeHealth('empty') });
      await expect(page.getByText('No new machines were created in this range.')).toBeVisible();
    });

    test('one section unavailable', async ({ page }) => {
      await audit(page, `partial-${viewport.label}`, {
        health: { ...makeHealth('normal'), latency: null, unavailable: ['latency'] },
      });
      await expect(page.getByText('Lifecycle latency could not be read just now.')).toBeVisible();
    });

    test('Cloudflare not configured explains what to set', async ({ page }) => {
      await audit(page, `cloudflare-unconfigured-${viewport.label}`, {
        health: {
          ...makeHealth('normal'),
          cloudflare: { ...makeCloudflare('empty'), status: 'not_configured' },
        },
      });
      await expect(page.getByTestId('cloudflare-status')).toContainText('CF_API_TOKEN');
      await expect(page.getByTestId('stat-cloudflare')).toContainText('Not set up');
    });

    test('Cloudflare token without analytics permission', async ({ page }) => {
      await audit(page, `cloudflare-permission-${viewport.label}`, {
        health: {
          ...makeHealth('normal'),
          cloudflare: {
            ...makeCloudflare('normal'),
            status: 'permission_denied',
            error: 'Cloudflare GraphQL error: Authentication error',
          },
        },
      });
      await expect(page.getByTestId('cloudflare-status')).toContainText(
        'cannot read account analytics'
      );
      await expect(page.getByTestId('cloudflare-status')).toContainText('Needs attention.');
      await expect(page.getByTestId('cloudflare-line')).toHaveCount(5);
    });

    test('Cloudflare Refresh now is reachable and runs', async ({ page }) => {
      await audit(page, `cloudflare-refresh-${viewport.label}`, { health: makeHealth('empty') });
      const refresh = page.getByTestId('cloudflare-refresh');
      await refresh.scrollIntoViewIfNeeded();
      const box = await refresh.boundingBox();
      expect(box).not.toBeNull();
      if (viewport.isMobile) expect(box!.height).toBeGreaterThanOrEqual(44);
      const request = page.waitForRequest('**/api/admin/health-cost/cloudflare/refresh');
      await refresh.click();
      expect((await request).method()).toBe('POST');
      await expect(page.getByText('Cloudflare cost updated')).toBeVisible();
    });

    test('error state', async ({ page }) => {
      await audit(page, `error-${viewport.label}`, { status: 500 });
      await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
    });
  });
}
