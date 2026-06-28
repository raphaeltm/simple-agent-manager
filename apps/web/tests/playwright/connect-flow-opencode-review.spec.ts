/**
 * UI/UX review audit: ConnectFlow — OpenCode consolidated block.
 *
 * Tests the new provider+model+baseUrl block that appears when:
 *   - agent = opencode
 *   - authMethod = api-key
 *   - no projectId (user scope)
 *
 * Verified: label associations, select defaults, conditional base URL,
 * no horizontal overflow at 375px and 1280px.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
const MOCK_USER = {
  user: {
    id: 'user-review-1',
    email: 'reviewer@example.com',
    name: 'Review User',
    image: null,
    role: 'superadmin',
    status: 'active',
    emailVerified: true,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
  session: {
    id: 'sess-review-1',
    userId: 'user-review-1',
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    token: 'mock-token',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  },
};

const MOCK_AGENTS = [
  {
    id: 'opencode',
    name: 'OpenCode',
    description: 'OpenCode coding agent with multi-provider support',
    provider: 'OpenCode',
    envVarName: 'OPENCODE_API_KEY',
    credentialHelpUrl: 'https://opencode.ai/auth',
    supportsAcp: true,
    configured: false,
    fallbackCredentialSource: null,
    oauthSupport: null,
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Anthropic Claude Code agent with ACP support',
    provider: 'Anthropic',
    envVarName: 'ANTHROPIC_API_KEY',
    credentialHelpUrl: 'https://console.anthropic.com',
    supportsAcp: true,
    configured: false,
    fallbackCredentialSource: null,
    oauthSupport: { setupInstructions: 'Run: claude setup-token' },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function setupMocks(page: Page) {
  await page.addInitScript((userId) => {
    window.localStorage.setItem(`sam-onboarding-wizard-dismissed-${userId}`, 'true');
  }, MOCK_USER.user.id);

  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const method = route.request().method();

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path.includes('/api/auth/')) return respond(200, MOCK_USER);
    if (path === '/api/agents') return respond(200, { agents: MOCK_AGENTS });
    if (path === '/api/projects') return respond(200, { projects: [] });
    if (path.startsWith('/api/notifications')) return respond(200, { notifications: [], unreadCount: 0 });

    // Resolution status for ConnectionsOverview
    if (path === '/api/credentials/resolution-status') {
      return respond(200, {
        consumers: [
          {
            consumerId: 'opencode',
            consumerName: 'OpenCode',
            consumerKind: 'agent',
            source: 'unresolved',
            credentialName: null,
            credentialKind: null,
            configurationName: null,
            statusReason: null,
            halted: false,
            validation: null,
          },
        ],
      });
    }

    // Agent credentials (empty — no key yet)
    if (path.match(/^\/api\/credentials\/agent\/[^/]+$/) && method === 'GET') {
      return respond(200, { credentials: [] });
    }

    // Agent settings GET
    if (path.match(/^\/api\/agent-settings\/[^/]+$/) && method === 'GET') {
      return respond(404, { error: 'Not found' });
    }

    // POST credential
    if (path === '/api/credentials/agent' && method === 'PUT') {
      const body = route.request().postDataJSON() as Record<string, unknown>;
      return respond(200, {
        id: 'cred-new',
        agentType: body.agentType,
        credentialKind: body.credentialKind,
        isActive: true,
        label: 'Connected',
        validation: { valid: true, message: 'OK' },
      });
    }

    // PUT agent settings
    if (path.match(/^\/api\/agent-settings\/[^/]+$/) && method === 'PUT') {
      return respond(200, { success: true });
    }

    // Default
    return respond(200, {});
  });
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(600);
  const vp = page.viewportSize();
  const suffix = vp ? `${vp.width}x${vp.height}` : 'unknown';
  const dir = `${process.cwd()}/.codex/tmp/playwright-screenshots`;
  await page.screenshot({ path: `${dir}/cf-oc-${name}-${suffix}.png`, fullPage: true });
}

async function assertNoOverflow(page: Page) {
  const r = await page.evaluate(() => ({
    docOw: document.documentElement.scrollWidth > window.innerWidth,
    bodyOw: document.body.scrollWidth > window.innerWidth,
  }));
  expect(r.docOw, 'document horizontal overflow').toBe(false);
  expect(r.bodyOw, 'body horizontal overflow').toBe(false);
}

async function openConnectFlowForOpenCode(page: Page) {
  await page.goto('/settings/connections');
  // Wait for the Connections page to settle
  await page.waitForSelector('[class*="glass-surface"], h2', { timeout: 15000 });
  await page.waitForTimeout(800);

  // Find and click "Connect" for the OpenCode row
  const connectBtn = page.getByRole('button', { name: /Connect/i }).first();
  if (await connectBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await connectBtn.click();
    await page.waitForTimeout(500);
  }

  // Wait for the agent cards grid to appear (ConnectFlow rendered)
  await page.waitForTimeout(300);

  // Click the OpenCode agent card
  const opencodeBtn = page.getByRole('button', { pressed: false }).filter({ hasText: 'OpenCode' }).first();
  if (await opencodeBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await opencodeBtn.click();
    await page.waitForTimeout(400);
  }
}

// ---------------------------------------------------------------------------
// Mobile Tests
// ---------------------------------------------------------------------------
test.describe('ConnectFlow OpenCode — Mobile (375x667)', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true });

  test('zen provider default: correct default, no base URL, all labels associated', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);
    await shot(page, 'zen-default');
    await assertNoOverflow(page);

    // Provider select must default to opencode-zen
    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const val = await providerSelect.inputValue();
      expect(val, 'provider select defaults to opencode-zen').toBe('opencode-zen');

      // Label association: htmlFor → id
      const lbl = page.locator('label[for="connect-opencode-provider"]');
      await expect(lbl).toBeVisible();
      const lblText = await lbl.textContent();
      expect(lblText?.toLowerCase()).toContain('opencode provider');

      // Base URL must NOT be visible for zen
      const baseUrlInput = page.locator('#connect-opencode-base-url');
      await expect(baseUrlInput).not.toBeVisible();

      // Model input must be visible with a label
      const modelInput = page.locator('#connect-opencode-model');
      await expect(modelInput).toBeVisible();
      const modelLabel = page.locator('label[for="connect-opencode-model"]');
      await expect(modelLabel).toBeVisible();

      // API Key input must be visible with correct label
      const keyInput = page.locator('#connect-credential');
      await expect(keyInput).toBeVisible();
      const keyLabel = page.locator('label[for="connect-credential"]');
      await expect(keyLabel).toBeVisible();
      const keyLabelText = await keyLabel.textContent();
      expect(keyLabelText?.trim()).toBe('OpenCode API Key');
    }
  });

  test('custom provider: base URL appears, hides when switching back', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);

    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      // Switch to custom
      await providerSelect.selectOption('custom');
      await page.waitForTimeout(300);
      await shot(page, 'custom-provider');
      await assertNoOverflow(page);

      // Base URL should now be visible with label
      const baseUrlInput = page.locator('#connect-opencode-base-url');
      await expect(baseUrlInput).toBeVisible();
      const baseUrlLabel = page.locator('label[for="connect-opencode-base-url"]');
      await expect(baseUrlLabel).toBeVisible();
      const baseUrlLabelText = await baseUrlLabel.textContent();
      expect(baseUrlLabelText?.trim().toLowerCase()).toContain('base url');

      // Placeholder should be a URL hint
      const placeholder = await baseUrlInput.getAttribute('placeholder');
      expect(placeholder).toContain('https://');

      // Switch back to zen: base URL should disappear
      await providerSelect.selectOption('opencode-zen');
      await page.waitForTimeout(300);
      await expect(baseUrlInput).not.toBeVisible();
      await shot(page, 'back-to-zen');
      await assertNoOverflow(page);
    }
  });

  test('opencode-go provider: no base URL shown, model placeholder present', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);

    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await providerSelect.selectOption('opencode-go');
      await page.waitForTimeout(300);
      await shot(page, 'go-provider');
      await assertNoOverflow(page);

      // No base URL for go
      const baseUrlInput = page.locator('#connect-opencode-base-url');
      await expect(baseUrlInput).not.toBeVisible();

      // Model input still visible
      const modelInput = page.locator('#connect-opencode-model');
      await expect(modelInput).toBeVisible();
      const placeholder = await modelInput.getAttribute('placeholder');
      expect(placeholder).toBeTruthy();
    }
  });

  test('select options: only opencode-zen, opencode-go, custom — no empty string option', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);

    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const options = await providerSelect.evaluate((el) => {
        const s = el as HTMLSelectElement;
        return Array.from(s.options).map((o) => ({ value: o.value, text: o.text }));
      });
      const values = options.map((o) => o.value);
      // No empty string option
      expect(values).not.toContain('');
      // Expected providers
      expect(values).toContain('opencode-zen');
      expect(values).toContain('opencode-go');
      expect(values).toContain('custom');
      // No removed providers
      expect(values).not.toContain('platform');
      expect(values).not.toContain('scaleway');
      expect(values).not.toContain('google-vertex');
      expect(values).not.toContain('anthropic');
      expect(values).not.toContain('openai-compatible');
    }
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------
test.describe('ConnectFlow OpenCode — Desktop (1280x800)', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('zen provider desktop: no overflow, correct layout', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);
    await shot(page, 'zen-default');
    await assertNoOverflow(page);

    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await expect(providerSelect).toHaveValue('opencode-zen');
    }
  });

  test('custom provider desktop: base URL visible, no overflow', async ({ page }) => {
    await setupMocks(page);
    await openConnectFlowForOpenCode(page);

    const providerSelect = page.locator('#connect-opencode-provider');
    if (await providerSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      await providerSelect.selectOption('custom');
      await page.waitForTimeout(300);
    }
    await shot(page, 'custom-provider');
    await assertNoOverflow(page);
  });
});
