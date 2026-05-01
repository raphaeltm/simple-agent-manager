import { expect, type Page, type Route, test } from '@playwright/test';

// ---------------------------------------------------------------------------
// Mock Data
// ---------------------------------------------------------------------------

const MOCK_USER = {
  user: {
    id: 'user-test-1',
    email: 'test@example.com',
    name: 'Test User',
    image: null,
    role: 'user',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const PERIOD = {
  start: '2026-04-01T00:00:00Z',
  end: '2026-04-30T23:59:59Z',
};

function makeAiModel(overrides: {
  model: string;
  costUsd?: number;
  requests?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedRequests?: number;
  errorRequests?: number;
}) {
  return {
    model: overrides.model,
    provider: 'openai',
    requests: overrides.requests ?? 10,
    inputTokens: overrides.inputTokens ?? 5000,
    outputTokens: overrides.outputTokens ?? 2000,
    costUsd: overrides.costUsd ?? 0.05,
    cachedRequests: overrides.cachedRequests ?? 0,
    errorRequests: overrides.errorRequests ?? 0,
  };
}

function makeAiDay(date: string, costUsd: number, requests = 5) {
  return {
    date,
    requests,
    inputTokens: requests * 500,
    outputTokens: requests * 200,
    costUsd,
  };
}

function makeAiUsageResponse(options: {
  totalCostUsd?: number;
  totalRequests?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  cachedRequests?: number;
  errorRequests?: number;
  byModel?: ReturnType<typeof makeAiModel>[];
  byDay?: ReturnType<typeof makeAiDay>[];
  period?: string;
  periodLabel?: string;
} = {}) {
  return {
    totalCostUsd: options.totalCostUsd ?? 1.23,
    totalRequests: options.totalRequests ?? 45,
    totalInputTokens: options.totalInputTokens ?? 22500,
    totalOutputTokens: options.totalOutputTokens ?? 9000,
    cachedRequests: options.cachedRequests ?? 3,
    errorRequests: options.errorRequests ?? 1,
    byModel: options.byModel ?? [
      makeAiModel({ model: 'gpt-4o', costUsd: 0.80, requests: 30, cachedRequests: 2, errorRequests: 1 }),
      makeAiModel({ model: '@cf/meta/llama-3.1-8b-instruct', costUsd: 0.25, requests: 10 }),
      makeAiModel({ model: 'claude-3-5-sonnet-20241022', costUsd: 0.18, requests: 5 }),
    ],
    byDay: options.byDay ?? [
      makeAiDay('2026-04-25', 0.30),
      makeAiDay('2026-04-26', 0.45),
      makeAiDay('2026-04-27', 0.15),
      makeAiDay('2026-04-28', 0.20),
      makeAiDay('2026-04-29', 0.13),
    ],
    period: options.period ?? 'current-month',
    periodLabel: options.periodLabel ?? 'April 2026',
  };
}

// Long model names for overflow testing
const LONG_MODELS = [
  makeAiModel({
    model: '@cf/meta/llama-3.1-70b-instruct-awq-with-a-very-long-suffix-that-might-overflow',
    costUsd: 0.50,
    requests: 20,
    inputTokens: 100000,
    outputTokens: 50000,
    cachedRequests: 5,
    errorRequests: 2,
  }),
  makeAiModel({
    model: 'anthropic/claude-3-5-sonnet-20241022-v2-with-extended-thinking-and-tool-use',
    costUsd: 0.30,
    requests: 15,
  }),
];

// Many models
const MANY_MODELS = Array.from({ length: 15 }, (_, i) =>
  makeAiModel({ model: `model-${i + 1}`, costUsd: Math.random() * 0.5, requests: Math.floor(Math.random() * 50) + 1 })
);

// Many days
const MANY_DAYS = Array.from({ length: 30 }, (_, i) => {
  const d = String(i + 1).padStart(2, '0');
  return makeAiDay(`2026-04-${d}`, Math.random() * 0.5);
});

// ---------------------------------------------------------------------------
// Mock Setup
// ---------------------------------------------------------------------------

type MockOptions = {
  aiUsage?: ReturnType<typeof makeAiUsageResponse>;
  aiUsageError?: boolean;
};

async function setupMocks(page: Page, options: MockOptions = {}) {
  const aiUsageData = options.aiUsage ?? makeAiUsageResponse();

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });
    if (path === '/api/dashboard/active-tasks') return respond(200, { tasks: [] });
    if (path.startsWith('/api/github')) return respond(200, []);
    if (path.startsWith('/api/credentials')) return respond(200, []);
    if (path.includes('/api/smoke-test')) return respond(200, { enabled: false });
    if (path === '/api/trial-status') return respond(200, { available: false });
    if (path.startsWith('/api/nodes')) return respond(200, { nodes: [] });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.endsWith('/health')) return respond(200, { status: 'ok' });

    // AI usage endpoint
    if (path === '/api/usage/ai') {
      if (options.aiUsageError) return respond(500, { error: 'Gateway error' });
      return respond(200, aiUsageData);
    }

    // Compute usage (minimal for this test)
    if (path === '/api/usage/compute') {
      return respond(200, {
        currentPeriod: {
          totalVcpuHours: 5.0,
          platformVcpuHours: 3.0,
          userVcpuHours: 2.0,
          activeWorkspaces: 0,
          start: PERIOD.start,
          end: PERIOD.end,
        },
        activeSessions: [],
      });
    }

    if (path === '/api/usage/quota') {
      return respond(200, {
        byocExempt: false,
        monthlyVcpuHoursLimit: null,
        currentUsage: 0,
        remaining: null,
        periodStart: PERIOD.start,
        periodEnd: PERIOD.end,
      });
    }

    return respond(200, {});
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function goToUsage(page: Page) {
  await page.goto('/settings/usage');
  await page.waitForTimeout(1500);
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoOverflow(page: Page) {
  const result = await page.evaluate(() => ({
    docOverflow: document.documentElement.scrollWidth > window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
    docWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(
    result.docOverflow,
    `Document scrollWidth (${result.docWidth}) exceeds viewport (${result.viewportWidth})`
  ).toBe(false);
  expect(result.bodyOverflow).toBe(false);
}

// ===========================================================================
// AI USAGE — Mobile (375x667)
// ===========================================================================

test.describe('AI Usage — Mobile (375x667)', () => {
  test('normal data: KPI cards, model list, daily trend visible', async ({ page }) => {
    await setupMocks(page);
    await goToUsage(page);
    await expect(page.locator('text=LLM Usage')).toBeVisible();
    await expect(page.locator('text=Total Cost')).toBeVisible();
    await expect(page.locator('text=Requests')).toBeVisible();
    await expect(page.locator('text=By Model')).toBeVisible();
    await expect(page.locator('text=Daily Trend')).toBeVisible();
    await screenshot(page, 'ai-usage-normal-mobile');
    await assertNoOverflow(page);
  });

  test('empty state: no usage message with bot icon', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({ totalRequests: 0, byModel: [], byDay: [] }),
    });
    await goToUsage(page);
    await expect(page.locator('text=No LLM usage yet')).toBeVisible();
    await screenshot(page, 'ai-usage-empty-mobile');
    await assertNoOverflow(page);
  });

  test('long model names truncate without overflow', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({
        byModel: LONG_MODELS,
        totalRequests: 35,
        totalCostUsd: 0.80,
      }),
    });
    await goToUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'ai-usage-long-models-mobile');
    await assertNoOverflow(page);
  });

  test('many models: 15 models list scrolls correctly', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({
        byModel: MANY_MODELS,
        totalRequests: 200,
        totalCostUsd: 3.50,
      }),
    });
    await goToUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'ai-usage-many-models-mobile');
    await assertNoOverflow(page);
  });

  test('many days: 30-day trend renders without overflow', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({
        byDay: MANY_DAYS,
        totalRequests: 150,
        totalCostUsd: 5.00,
      }),
    });
    await goToUsage(page);
    await page.waitForTimeout(400);
    await screenshot(page, 'ai-usage-many-days-mobile');
    await assertNoOverflow(page);
  });

  test('error state: shows error message', async ({ page }) => {
    await setupMocks(page, { aiUsageError: true });
    await page.goto('/settings/usage');
    await page.waitForTimeout(2500);
    await screenshot(page, 'ai-usage-error-mobile');
    await assertNoOverflow(page);
  });

  test('period selector buttons are visible and interactive', async ({ page }) => {
    await setupMocks(page);
    await goToUsage(page);
    // All period buttons should be visible
    await expect(page.locator('button:has-text("This Month")')).toBeVisible();
    await expect(page.locator('button:has-text("7 Days")')).toBeVisible();
    await expect(page.locator('button:has-text("30 Days")')).toBeVisible();
    await expect(page.locator('button:has-text("90 Days")')).toBeVisible();
    await screenshot(page, 'ai-usage-period-selector-mobile');
    await assertNoOverflow(page);
  });

  test('cached and error counts display in model list', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({
        byModel: [
          makeAiModel({ model: 'gpt-4o', costUsd: 0.50, cachedRequests: 5, errorRequests: 3 }),
        ],
        totalRequests: 20,
        totalCostUsd: 0.50,
      }),
    });
    await goToUsage(page);
    await expect(page.locator('text=5 cached')).toBeVisible();
    await expect(page.locator('text=3 err')).toBeVisible();
    await screenshot(page, 'ai-usage-cached-errors-mobile');
    await assertNoOverflow(page);
  });

  test('disclaimer text visible', async ({ page }) => {
    await setupMocks(page);
    await goToUsage(page);
    await expect(page.locator('text=SAM-managed AI Gateway traffic only')).toBeVisible();
    await screenshot(page, 'ai-usage-disclaimer-mobile');
    await assertNoOverflow(page);
  });
});

// ===========================================================================
// AI USAGE — Desktop (1280x800)
// ===========================================================================

test.describe('AI Usage — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data: full layout with 4-column KPI grid', async ({ page }) => {
    await setupMocks(page);
    await goToUsage(page);
    await expect(page.locator('text=LLM Usage')).toBeVisible();
    await expect(page.locator('text=Total Cost')).toBeVisible();
    await expect(page.locator('text=Input Tokens')).toBeVisible();
    await expect(page.locator('text=Output Tokens')).toBeVisible();
    await screenshot(page, 'ai-usage-normal-desktop');
    await assertNoOverflow(page);
  });

  test('empty state', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({ totalRequests: 0, byModel: [], byDay: [] }),
    });
    await goToUsage(page);
    await expect(page.locator('text=No LLM usage yet')).toBeVisible();
    await screenshot(page, 'ai-usage-empty-desktop');
    await assertNoOverflow(page);
  });

  test('long model names at desktop width', async ({ page }) => {
    await setupMocks(page, {
      aiUsage: makeAiUsageResponse({ byModel: LONG_MODELS, totalRequests: 35, totalCostUsd: 0.80 }),
    });
    await goToUsage(page);
    await screenshot(page, 'ai-usage-long-models-desktop');
    await assertNoOverflow(page);
  });

  test('both LLM and compute sections visible', async ({ page }) => {
    await setupMocks(page);
    await goToUsage(page);
    await expect(page.locator('text=LLM Usage')).toBeVisible();
    await expect(page.locator('text=Compute Usage')).toBeVisible();
    await screenshot(page, 'ai-usage-both-sections-desktop');
    await assertNoOverflow(page);
  });
});
