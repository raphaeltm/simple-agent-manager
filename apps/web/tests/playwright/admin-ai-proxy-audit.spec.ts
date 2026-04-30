import { expect, type Page, type Route, test } from '@playwright/test';

const SCREENSHOT_DIR = '../../.codex/tmp/playwright-screenshots';

const MOCK_USER = {
  user: {
    id: 'user-test-1',
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
    id: 'session-test-1',
    userId: 'user-test-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    defaultModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
    source: 'default',
    updatedAt: null,
    hasAnthropicCredential: false,
    hasOpenAICredential: false,
    hasUnifiedBilling: false,
    models: [
      { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'Llama 4 Scout 17B', provider: 'workers-ai', tier: 'free', costPer1kInputTokens: 0, costPer1kOutputTokens: 0, isDefault: true, available: true },
      { id: '@cf/qwen/qwen3-30b-a3b-fp8', label: 'Qwen3 30B', provider: 'workers-ai', tier: 'free', costPer1kInputTokens: 0, costPer1kOutputTokens: 0, available: true },
      { id: '@cf/google/gemma-3-12b-it', label: 'Gemma 3 12B', provider: 'workers-ai', tier: 'free', costPer1kInputTokens: 0, costPer1kOutputTokens: 0, available: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', provider: 'anthropic', tier: 'standard', costPer1kInputTokens: 0.0008, costPer1kOutputTokens: 0.004, available: false },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', provider: 'anthropic', tier: 'standard', costPer1kInputTokens: 0.003, costPer1kOutputTokens: 0.015, available: false },
      { id: 'gpt-4.1-mini', label: 'GPT-4.1 Mini', provider: 'openai', tier: 'standard', costPer1kInputTokens: 0.0004, costPer1kOutputTokens: 0.0016, available: false },
      { id: 'gpt-4.1', label: 'GPT-4.1', provider: 'openai', tier: 'standard', costPer1kInputTokens: 0.002, costPer1kOutputTokens: 0.008, available: false },
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', provider: 'anthropic', tier: 'premium', costPer1kInputTokens: 0.015, costPer1kOutputTokens: 0.075, available: false },
      { id: 'gpt-5.2', label: 'GPT-5.2', provider: 'openai', tier: 'premium', costPer1kInputTokens: 0.01, costPer1kOutputTokens: 0.04, available: false },
    ],
    ...overrides,
  };
}

async function setupApiMocks(page: Page, options: { config?: ReturnType<typeof makeConfig> } = {}) {
  const config = options.config ?? makeConfig();

  await page.route('**/api/auth/get-session', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) });
  });

  await page.route('**/api/admin/ai-proxy/config', async (route: Route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(config) });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ defaultModel: config.defaultModel, source: 'admin', updatedAt: new Date().toISOString() }) });
    }
  });

  // Catch-all for other API routes
  await page.route('**/api/**', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `${SCREENSHOT_DIR}/${name}.png`,
    fullPage: true,
  });
}

// =============================================================================
// Mobile Tests (375x667)
// =============================================================================

test.describe('AdminAIProxy — Mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('normal data — free tier default', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-normal-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('all credentials configured + admin override', async ({ page }) => {
    await setupApiMocks(page, {
      config: makeConfig({
        defaultModel: 'claude-sonnet-4-6',
        source: 'admin',
        updatedAt: '2026-04-30T12:00:00Z',
        hasAnthropicCredential: true,
        hasOpenAICredential: true,
        hasUnifiedBilling: true,
        models: makeConfig().models.map((m: Record<string, unknown>) => ({ ...m, available: true })),
      }),
    });
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-all-creds-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('unified billing only', async ({ page }) => {
    await setupApiMocks(page, {
      config: makeConfig({
        hasUnifiedBilling: true,
        models: makeConfig().models.map((m: Record<string, unknown>) => ({ ...m, available: true })),
      }),
    });
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-unified-billing-mobile');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('error state', async ({ page }) => {
    await page.route('**/api/auth/get-session', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(MOCK_USER) });
    });
    await page.route('**/api/admin/ai-proxy/config', async (route: Route) => {
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Internal Server Error' }) });
    });
    await page.route('**/api/**', async (route: Route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-error-mobile');
  });
});

// =============================================================================
// Desktop Tests (1280x800)
// =============================================================================

test.describe('AdminAIProxy — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('normal data — free tier default', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-normal-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('all credentials configured + admin override', async ({ page }) => {
    await setupApiMocks(page, {
      config: makeConfig({
        defaultModel: 'claude-sonnet-4-6',
        source: 'admin',
        updatedAt: '2026-04-30T12:00:00Z',
        hasAnthropicCredential: true,
        hasOpenAICredential: true,
        hasUnifiedBilling: true,
        models: makeConfig().models.map((m: Record<string, unknown>) => ({ ...m, available: true })),
      }),
    });
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-all-creds-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('unified billing only', async ({ page }) => {
    await setupApiMocks(page, {
      config: makeConfig({
        hasUnifiedBilling: true,
        models: makeConfig().models.map((m: Record<string, unknown>) => ({ ...m, available: true })),
      }),
    });
    await page.goto('/admin/ai-proxy');
    await screenshot(page, 'admin-ai-proxy-unified-billing-desktop');

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });
});
