/**
 * Settings > Usage budget controls with the installation monthly ceiling (L13, F2): the bar shows
 * the cap actually enforced, the form explains and bounds the ceiling, and an installation that
 * cannot price spend shows a note instead of a cap field. Mobile and desktop.
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, seedTheme } from './audit-helpers';

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

/** Bodies the page sent to PUT /api/usage/ai/budget. */
type Puts = Array<Record<string, unknown>>;

async function setup(page: Page, scenario: Scenario, puts: Puts = []) {
  // The first-run onboarding modal would otherwise cover the page (rule 62).
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await page.route('**/api/**', (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/usage/ai/budget' && route.request().method() === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      puts.push(body);
      // Enforce the receiver's contract (rule 23): no cap where unpriced, none above the ceiling.
      const cap = body.monthlyCostCapUsd as number | null;
      const refused =
        cap !== null &&
        (!scenario.available || (scenario.ceilingUsd !== null && cap > scenario.ceilingUsd));
      return route.fulfill({
        status: refused ? 400 : 200,
        contentType: 'application/json',
        body: JSON.stringify(
          refused ? { error: 'VALIDATION_ERROR', message: 'refused' } : { success: true }
        ),
      });
    }
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
      return respond({
        currentPeriod: {
          totalNodeHours: 0,
          totalVcpuHours: 0,
          platformNodeHours: 0,
          platformVcpuHours: 0,
          userNodeHours: 0,
          userVcpuHours: 0,
          activeNodes: 0,
          activeWorkspaces: 0,
          start: '2026-11-01T00:00:00Z',
          end: '2026-11-30T23:59:59Z',
        },
        activeSessions: [],
      });
    }
    if (path.startsWith('/api/credentials') || path.startsWith('/api/github')) return respond([]);
    if (path === '/api/projects') return respond({ projects: [] });
    if (path.startsWith('/api/nodes')) return respond({ nodes: [] });
    return respond({});
  });
  await page.goto('/settings/usage');
  await expect(page.getByText('Budget Controls')).toBeVisible();
}

async function checkLayout(page: Page) {
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
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
      const bar = page.getByRole('meter', { name: 'Monthly Cost Cap (administrator limit)' });
      await expect(bar).toBeVisible();
      await expect(bar).toHaveAttribute('aria-valuenow', '74');
      await expect(bar).toHaveAttribute('aria-valuetext', '$18.40 of $25.00 (74%)');
      await expect(page.getByText('$18.40 / $25.00')).toBeVisible();
      await checkLayout(page);
      await shot(page, `ceiling-binds-${viewportName(page)}`);
    });

    test('a lower user cap is shown as the user cap', async ({ page }) => {
      await setup(page, { userCap: 10, ceilingUsd: 25, available: true, monthCostUsd: 4 });
      const bar = page.getByRole('meter', { name: 'Monthly Cost Cap', exact: true });
      await expect(bar).toHaveAttribute('aria-valuenow', '40');
      await expect(page.getByText('$4.00 / $10.00')).toBeVisible();
      await expect(page.getByText('(administrator limit)')).toHaveCount(0);
      await checkLayout(page);
      await shot(page, `user-cap-${viewportName(page)}`);
    });

    test('exceeded at the ceiling shows the exceeded alert', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 31 });
      await expect(page.getByRole('alert')).toContainText('Budget Exceeded');
      await expect(page.getByRole('alert')).toContainText('set by your administrator');
      await expect(page.getByRole('alert')).toContainText('resets on the 1st');
      await checkLayout(page);
      await shot(page, `exceeded-${viewportName(page)}`);
    });

    test('the form explains and bounds the ceiling', async ({ page }) => {
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 3 });
      await page.getByRole('button', { name: 'Configure' }).click();
      const field = page.getByLabel('Monthly Cost Cap (USD)');
      await expect(field).toHaveAttribute('max', '25');
      await expect(field).toHaveAccessibleDescription(/limits everyone to \$25\.00 a month/);
      await checkLayout(page);
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
      await checkLayout(page);
      await shot(page, `unavailable-${viewportName(page)}`);
    });
    test('a saved cap above the ceiling is enforced at the ceiling and cannot be saved', async ({
      page,
    }) => {
      const puts: Puts = [];
      await setup(page, { userCap: 40, ceilingUsd: 25, available: true, monthCostUsd: 5 }, puts);
      const bar = page.getByRole('meter', { name: 'Monthly Cost Cap (administrator limit)' });
      await expect(bar).toHaveAttribute('aria-valuetext', '$5.00 of $25.00 (20%)');
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.locator('#monthlyCapCeiling')).toContainText(
        'saved cap of $40.00 is above it'
      );
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(
        page.getByText("can't be above your administrator's limit of $25.00")
      ).toBeVisible();
      expect(puts).toHaveLength(0);
      await page.getByLabel('Monthly Cost Cap (USD)').fill('20');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Budget settings saved.')).toBeVisible();
      expect(puts.at(-1)).toMatchObject({ monthlyCostCapUsd: 20 });
      await checkLayout(page);
      await shot(page, `saved-above-ceiling-${viewportName(page)}`);
    });

    test('cap unavailable: saving other limits succeeds and clears the unenforced cap', async ({
      page,
    }) => {
      const puts: Puts = [];
      await setup(page, { userCap: 40, ceilingUsd: null, available: false, monthCostUsd: 0 }, puts);
      await page.getByRole('button', { name: 'Configure' }).click();
      await page.getByLabel('Daily Input Token Limit').fill('300000');
      await page.getByRole('button', { name: 'Save' }).click();
      await expect(page.getByText('Budget settings saved.')).toBeVisible();
      expect(puts.at(-1)).toMatchObject({ dailyInputTokenLimit: 300000, monthlyCostCapUsd: null });
    });

    test('user cap without a ceiling still shows its bar (regression control)', async ({
      page,
    }) => {
      await setup(page, { userCap: 50, ceilingUsd: null, available: true, monthCostUsd: 12.34 });
      await expect(
        page.getByRole('meter', { name: 'Monthly Cost Cap', exact: true })
      ).toHaveAttribute('aria-valuetext', '$12.34 of $50.00 (25%)');
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.locator('#monthlyCapCeiling')).toHaveCount(0);
    });

    test('long values wrap without overflow', async ({ page }) => {
      // The narrowest supported width on the mobile project.
      if (viewportName(page) === 'mobile') await page.setViewportSize({ width: 320, height: 667 });
      await setup(page, {
        userCap: null,
        ceilingUsd: 1_000_000,
        available: true,
        monthCostUsd: 123_456.78,
      });
      await expect(
        page.getByRole('meter', { name: 'Monthly Cost Cap (administrator limit)' })
      ).toBeVisible();
      await page.getByRole('button', { name: 'Configure' }).click();
      await checkLayout(page);
      await shot(page, `long-values-${viewportName(page)}`);
    });
    test('light theme: ceiling bar and hint', async ({ page }) => {
      await seedTheme(page, 'light');
      await setup(page, { userCap: null, ceilingUsd: 25, available: true, monthCostUsd: 18.4 });
      await page.getByRole('button', { name: 'Configure' }).click();
      await expect(page.locator('#monthlyCapCeiling')).toBeVisible();
      await checkLayout(page);
      await shot(page, `light-${viewportName(page)}`);
    });
  });
}
