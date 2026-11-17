/**
 * Settings > Usage budget controls with the installation monthly ceiling (L13, F2): the bar shows
 * the cap actually enforced, the form explains and bounds the ceiling, and an installation that
 * cannot price spend shows a note instead of a cap field. Mobile and desktop.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow } from './audit-helpers';

const MOCK_USER = {
  user: {
    id: 'user-1',
    email: 'member@example.com',
    name: 'Member',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-1',
    userId: 'user-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

interface Scenario {
  userCap: number | null;
  ceilingUsd: number | null;
  available: boolean;
  monthCostUsd: number;
}

function budget({ userCap, ceilingUsd, available, monthCostUsd }: Scenario) {
  const caps = [userCap, ceilingUsd].filter((c): c is number => c !== null && c > 0);
  const effectiveCapUsd = available && caps.length ? Math.min(...caps) : null;
  const pct = effectiveCapUsd ? Math.min(100, (monthCostUsd / effectiveCapUsd) * 100) : null;
  return {
    settings: {
      dailyInputTokenLimit: null,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: userCap,
      alertThresholdPercent: 80,
    },
    isCustom: userCap !== null,
    dailyUsage: { inputTokens: 120_000, outputTokens: 40_000 },
    effectiveLimits: { dailyInputTokenLimit: 500_000, dailyOutputTokenLimit: 200_000 },
    monthCostUsd,
    monthlyCostCap: { available, ceilingUsd, effectiveCapUsd },
    utilization: { dailyInputPercent: 24, dailyOutputPercent: 20, monthlyCostPercent: pct },
    exceeded: pct !== null && pct >= 100,
  };
}

async function setup(page: Page, scenario: Scenario) {
  await page.route('**/api/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    const respond = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.includes('/api/auth/')) return respond(MOCK_USER);
    if (path.startsWith('/api/notifications'))
      return respond({ notifications: [], unreadCount: 0 });
    if (path === '/api/usage/ai/budget') return respond(budget(scenario));
    if (path === '/api/usage/ai') {
      return respond({
        totalCostUsd: scenario.monthCostUsd,
        totalRequests: 12,
        totalInputTokens: 120_000,
        totalOutputTokens: 40_000,
        cachedRequests: 0,
        errorRequests: 0,
        byModel: [],
        byProvider: [],
        byDay: [],
        period: 'current-month',
        periodLabel: 'November 2026',
      });
    }
    if (path === '/api/usage/quota') {
      return respond({
        byocExempt: false,
        monthlyVcpuHoursLimit: null,
        currentUsage: 0,
        remaining: null,
        periodStart: '2026-11-01T00:00:00Z',
        periodEnd: '2026-11-30T23:59:59Z',
      });
    }
    if (path === '/api/usage/compute') {
      return respond({ currentPeriod: null, activeSessions: [], nodes: [], totals: {} });
    }
    if (path.startsWith('/api/credentials') || path.startsWith('/api/github')) return respond([]);
    if (path === '/api/projects') return respond({ projects: [] });
    if (path.startsWith('/api/nodes')) return respond({ nodes: [] });
    return respond({});
  });
  await page.goto('/settings/usage');
  await expect(page.getByText('Budget Controls')).toBeVisible();
}

async function shot(page: Page, name: string) {
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/monthly-ceiling-${name}.png`,
    fullPage: true,
  });
}

function viewportName(page: Page): string {
  return (page.viewportSize()?.width ?? 0) < 640 ? 'mobile' : 'desktop';
}

{
  test.describe('monthly cost ceiling', () => {
    test('ceiling binds when the user set no cap', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 18.4 });
      const bar = page.getByRole('meter', { name: 'Monthly Cost Cap (installation limit)' });
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('aria-valuenow', '74');
      await assertNoOverflow(page);
      await shot(page, `ceiling-binds-${viewportName(page)}`);
    });

    test('a lower user cap is shown as the user cap', async ({ page }) => {
      await setup(page, { userCap: 10, ceilingUsd: 25, available: true, monthCostUsd: 4 });
      await expect(page.getByRole('meter', { name: 'Monthly Cost Cap' })).toBeVisible();
      await expect(page.getByText('(installation limit)')).toHaveCount(0);
      await assertNoOverflow(page);
      await shot(page, `user-cap-${viewportName(page)}`);
    });

    test('exceeded at the ceiling shows the exceeded alert', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 31 });
      await expect(page.getByRole('alert')).toContainText('Budget Exceeded');
      await assertNoOverflow(page);
      await shot(page, `exceeded-${viewportName(page)}`);
    });

    test('the form explains and bounds the ceiling', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 3 });
      await page.getByRole('button', { name: 'Configure' }).click();
      const field = page.getByLabel('Monthly Cost Cap (USD)');
      await expect(field).toHaveAttribute('max', '25');
      await expect(page.locator('#monthlyCapCeiling')).toContainText('limits everyone to');
      await assertNoOverflow(page);
      await shot(page, `form-ceiling-${viewportName(page)}`);
    });

    test('no ceiling: no hint, no bar, unchanged form (control)', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: null, available: true, monthCostUsd: 3 });
      await expect(page.getByRole('meter', { name: /Monthly Cost Cap/ })).toHaveCount(0);
      await expect(page.getByRole('meter', { name: 'Daily Input Tokens' })).toBeVisible();
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.getByLabel('Monthly Cost Cap (USD)')).toHaveAttribute(
        'placeholder',
        'No limit'
      );
      await expect(page.locator('#monthlyCapCeiling')).toHaveCount(0);
      await shot(page, `no-ceiling-${viewportName(page)}`);
    });

    test('cap unavailable: note shown, cap field hidden', async ({ page }) => {
      await setup(page, { userCap: 40, ceilingUsd: null, available: false, monthCostUsd: 0 });
      await expect(page.getByTestId('monthly-cap-unavailable')).toBeVisible();
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.getByLabel('Monthly Cost Cap (USD)')).toHaveCount(0);
      await expect(page.getByLabel('Daily Input Token Limit')).toBeVisible();
      await assertNoOverflow(page);
      await shot(page, `unavailable-${viewportName(page)}`);
    });
  });
}
