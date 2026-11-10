/**
 * Visual audit for the monthly AI cost cap when this installation has no Cloudflare AI Gateway
 * (`monthlyCostCapAvailable: false`): Settings > Usage budget controls and the admin AI proxy
 * page. The Cloudflare case (cap available) is the control.
 *
 *   npx playwright test monthly-cost-cap-audit \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 */
import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, jsonResponse, makeMockUser, screenshot } from './audit-helpers';

const MOCK_USER = makeMockUser({
  email: 'a-very-long-operator-address-for-wrapping-checks@self-hosted.example.com',
  name: 'Operator',
  role: 'superadmin',
  sessionId: 'session-cap-1',
  userId: 'user-cap-1',
});

interface Scenario {
  capAvailable: boolean;
  storedCapUsd: number | null;
}

function budget({ capAvailable, storedCapUsd }: Scenario) {
  return {
    settings: {
      dailyInputTokenLimit: 1_000_000,
      dailyOutputTokenLimit: null,
      monthlyCostCapUsd: storedCapUsd,
      alertThresholdPercent: 80,
    },
    isCustom: true,
    dailyUsage: { inputTokens: 412_345, outputTokens: 98_765 },
    effectiveLimits: { dailyInputTokenLimit: 1_000_000, dailyOutputTokenLimit: 200_000 },
    monthCostUsd: capAvailable ? 17.42 : 0,
    monthlyCostCapAvailable: capAvailable,
    utilization: {
      dailyInputPercent: 41.2,
      dailyOutputPercent: 49.4,
      monthlyCostPercent: capAvailable && storedCapUsd ? 69.7 : null,
    },
    exceeded: false,
  };
}

function aiProxyConfig(capAvailable: boolean) {
  return {
    defaultModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    source: 'default',
    updatedAt: null,
    hasAnthropicCredential: true,
    hasOpenAICredential: false,
    hasUnifiedBilling: false,
    billingMode: 'auto',
    monthlyCostCapAvailable: capAvailable,
    models: [
      {
        id: '@cf/meta/llama-4-scout-17b-16e-instruct',
        label: 'Llama 4 Scout 17B',
        provider: 'workers-ai',
        tier: 'low-cost',
        costPer1kInputTokens: 0.00027,
        costPer1kOutputTokens: 0.00085,
        isDefault: true,
        available: true,
      },
    ],
  };
}

async function setupMocks(page: Page, scenario: Scenario) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);
  await page.route('**/api/**', async (route: Route) => {
    const p = new URL(route.request().url()).pathname;
    if (p.includes('/api/auth/')) return jsonResponse(route, 200, MOCK_USER);
    if (p.startsWith('/api/notifications'))
      return jsonResponse(route, 200, { notifications: [], unreadCount: 0 });
    if (p === '/api/dashboard/active-tasks') return jsonResponse(route, 200, { tasks: [] });
    if (p === '/api/usage/ai/budget') return jsonResponse(route, 200, budget(scenario));
    if (p === '/api/usage/ai')
      return jsonResponse(route, 200, {
        totalCostUsd: 0,
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        cachedRequests: 0,
        errorRequests: 0,
        byModel: [],
        byDay: [],
        period: 'current-month',
        periodLabel: 'November 2026',
      });
    if (p === '/api/usage/compute')
      return jsonResponse(route, 200, {
        currentPeriod: {
          start: '2026-11-01T00:00:00Z',
          end: '2026-11-30T23:59:59Z',
          totalVcpuHours: 0,
          platformVcpuHours: 0,
          userVcpuHours: 0,
          activeWorkspaces: 0,
        },
        activeSessions: [],
      });
    if (p === '/api/usage/quota')
      return jsonResponse(route, 200, {
        byocExempt: false,
        monthlyVcpuHoursLimit: null,
        currentUsage: 0,
        remaining: null,
        periodStart: '2026-11-01T00:00:00Z',
        periodEnd: '2026-11-30T23:59:59Z',
      });
    if (p === '/api/admin/ai-proxy/config')
      return jsonResponse(route, 200, aiProxyConfig(scenario.capAvailable));
    if (p === '/api/projects') return jsonResponse(route, 200, { projects: [] });
    if (p.startsWith('/api/credentials')) return jsonResponse(route, 200, []);
    return jsonResponse(route, 200, {});
  });
}

async function openBudgetEditor(page: Page) {
  await page.goto('/settings/usage');
  const configure = page.getByRole('button', { name: /configure/i });
  await expect(configure).toBeVisible({ timeout: 10_000 });
  await configure.click();
  await expect(page.getByLabel('Daily Input Token Limit')).toBeVisible();
}

const SCENARIOS: Array<[string, Scenario]> = [
  ['with-gateway', { capAvailable: true, storedCapUsd: 25 }],
  ['no-gateway-saved-cap', { capAvailable: false, storedCapUsd: 98765432.1 }],
  ['no-gateway-no-cap', { capAvailable: false, storedCapUsd: null }],
];

for (const [name, scenario] of SCENARIOS) {
  test(`budget controls: ${name}`, async ({ page }) => {
    await setupMocks(page, scenario);
    await openBudgetEditor(page);

    const capInput = page.getByLabel('Monthly Cost Cap (USD)');
    const note = page.getByTestId('monthly-cap-unavailable');
    if (scenario.capAvailable) {
      await expect(capInput).toBeVisible();
      await expect(note).toHaveCount(0);
      await expect(page.getByText('Monthly Cost Cap', { exact: true })).toBeVisible();
    } else {
      await expect(capInput).toHaveCount(0);
      await expect(note).toBeVisible();
      await expect(note).toContainText('Monthly cost caps are not available');
      if (scenario.storedCapUsd) await expect(note).toContainText('is not enforced here');
    }
    // The app scrolls inside its own wrapper: capture the cap area (note, or the cap input).
    await (scenario.capAvailable ? capInput : note).scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, `monthly-cap-budget-${name}`);
    // The open editor (cap input, or the save-clears hint) beside Save.
    await page.getByRole('button', { name: 'Save', exact: true }).scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(page, `monthly-cap-budget-${name}-form`);
  });
}

for (const capAvailable of [true, false]) {
  test(`admin AI proxy: monthly cap ${capAvailable ? 'available' : 'unavailable'}`, async ({
    page,
  }) => {
    await setupMocks(page, { capAvailable, storedCapUsd: null });
    await page.goto('/admin/ai-proxy');
    await expect(page.getByText('Billing Mode', { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('admin-monthly-cap-unavailable')).toHaveCount(
      capAvailable ? 0 : 1
    );
    // The app scrolls inside its own wrapper, so bring the area under review into the capture.
    await (
      capAvailable
        ? page.getByText('Default Model', { exact: true })
        : page.getByTestId('admin-monthly-cap-unavailable')
    ).scrollIntoViewIfNeeded();
    await assertNoOverflow(page);
    await screenshot(
      page,
      `monthly-cap-admin-ai-proxy-${capAvailable ? 'available' : 'unavailable'}`
    );
  });
}
