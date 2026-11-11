import { expect, type Page, type Route, test } from '@playwright/test';

import { assertNoOverflow, seedTheme } from './audit-helpers';

// ---------------------------------------------------------------------------
// API Mock — unauthenticated user (no session)
// ---------------------------------------------------------------------------

const GITHUB_ONLY = { github: true, google: false, gitlab: false, email: false };
const EMAIL_ONLY = { github: false, google: false, gitlab: false, email: true };
const ALL_PROVIDERS = { github: true, google: true, gitlab: true, email: true };

type ProvidersMock = Record<string, boolean> | 'hang' | 'error';

async function setupApiMocks(page: Page, providers: ProvidersMock = GITHUB_ONLY) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    // Auth session — return empty (unauthenticated)
    if (url.includes('/api/auth/get-session')) {
      return route.fulfill({ status: 200, json: {} });
    }

    if (url.includes('/api/config/login-providers')) {
      if (providers === 'hang') return; // never answers: the page must stay neutral
      if (providers === 'error') {
        return route.fulfill({ status: 500, json: { error: 'INTERNAL', message: 'boom' } });
      }
      return route.fulfill({ status: 200, json: providers });
    }

    // Default: 404
    return route.fulfill({ status: 404, json: { error: 'Not found' } });
  });
}

// ---------------------------------------------------------------------------
// Screenshot helper
// ---------------------------------------------------------------------------

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

// ---------------------------------------------------------------------------
// Glass node field: the shared renderer (packages/ui) draws behind the card
// ---------------------------------------------------------------------------

async function expectGlassNodeField(page: Page) {
  const field = page.getByTestId('glass-node-field');
  await expect(field).toHaveAttribute('aria-hidden', 'true');
  // The renderer loads on mount and adds its static and dynamic canvases.
  await expect(field.locator('canvas')).toHaveCount(2);
}

// ---------------------------------------------------------------------------
// Mobile Tests (default from playwright config: 375x667)
// ---------------------------------------------------------------------------

test.describe('Landing — Mobile', () => {
  test('renders sign-in page correctly', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.waitForSelector('text=Simple Agent Manager');

    // Core elements present
    await expect(page.getByText('Simple Agent Manager')).toBeVisible();
    await expect(page.getByText('Sign in with GitHub')).toBeVisible();
    await expect(page.getByText('Claude Code')).toBeVisible();
    await expect(page.getByText('OpenAI Codex')).toBeVisible();
    await expect(page.getByText('Gemini CLI')).toBeVisible();
    await expect(page.getByText('Mistral Vibe')).toBeVisible();
    await expect(page.getByText(/Bring your own cloud/)).toBeVisible();
    await expect(page.getByText('Learn more about SAM')).toBeVisible();

    // Marketing sections removed
    await expect(page.getByText('How It Works')).not.toBeVisible();
    await expect(page.getByText('Choose Your Agent')).not.toBeVisible();
    await expect(page.getByText('Platform Features')).not.toBeVisible();
    await expect(page.getByText('Shipped & Planned')).not.toBeVisible();
    await expect(page.getByText('Ready to start building?')).not.toBeVisible();

    await expectGlassNodeField(page);
    await assertNoOverflow(page);
    await screenshot(page, 'landing-sign-in-mobile');
  });

  test('sign-in button is full width on mobile', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.waitForSelector('text=Sign in with GitHub');

    const button = page.getByRole('button', { name: 'Sign in with GitHub' });
    const box = await button.boundingBox();
    expect(box).not.toBeNull();
    // Button should span most of the viewport width (max-w-sm = 384px, but viewport is 375px)
    expect(box!.width).toBeGreaterThan(300);

    await assertNoOverflow(page);
    await screenshot(page, 'landing-button-mobile');
  });
});

// ---------------------------------------------------------------------------
// Desktop Tests
// ---------------------------------------------------------------------------

test.describe('Landing — Desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false });

  test('renders centered sign-in page', async ({ page }) => {
    await setupApiMocks(page);
    await page.goto('/');
    await page.waitForSelector('text=Simple Agent Manager');

    // Core elements present
    await expect(page.getByText('Simple Agent Manager')).toBeVisible();
    await expect(page.getByText('Sign in with GitHub')).toBeVisible();
    await expect(page.getByText('Claude Code')).toBeVisible();
    await expect(page.getByText('Learn more about SAM')).toBeVisible();

    // Content should be centered — the card container should not be at the left edge
    const container = page.locator('div.max-w-sm');
    const box = await container.boundingBox();
    expect(box).not.toBeNull();
    // Centered: left offset should be > 400px on a 1280px viewport
    expect(box!.x).toBeGreaterThan(400);

    await expectGlassNodeField(page);
    await assertNoOverflow(page);
    await screenshot(page, 'landing-sign-in-desktop');
  });
});

// ---------------------------------------------------------------------------
// Sign-in option states (both viewports)
// ---------------------------------------------------------------------------

for (const viewport of [
  { name: 'mobile', size: { width: 375, height: 667 }, isMobile: true },
  { name: 'desktop', size: { width: 1280, height: 800 }, isMobile: false },
]) {
  test.describe(`Landing sign-in options — ${viewport.name}`, () => {
    test.use({ viewport: viewport.size, isMobile: viewport.isMobile });

    test('first visit shows a neutral pending state, never a guessed GitHub button', async ({
      page,
    }) => {
      await setupApiMocks(page, 'hang');
      await page.goto('/');
      await expect(page.getByText('Simple Agent Manager')).toBeVisible();
      await expect(page.getByRole('status', { name: 'Loading sign-in options' })).toBeVisible();
      await expect(page.getByText('Sign in with GitHub')).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `landing-pending-${viewport.name}`);
    });

    test('email-only install shows the email form and no GitHub button', async ({ page }) => {
      await setupApiMocks(page, EMAIL_ONLY);
      await page.goto('/');
      await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
      await expect(page.getByText('Sign in with GitHub')).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `landing-email-only-${viewport.name}`);
    });

    test('every provider configured', async ({ page }) => {
      await setupApiMocks(page, ALL_PROVIDERS);
      await page.goto('/');
      await expect(page.getByText('Sign in with GitLab')).toBeVisible();
      await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `landing-all-providers-${viewport.name}`);
    });

    test('a test instance says it accepts agent sign-in', async ({ page }) => {
      await setupApiMocks(page, { ...ALL_PROVIDERS, agentSignIn: true });
      await page.goto('/');
      const notice = page.getByRole('note');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('Agents from a trusted SAM installation');
      await expect(page.getByText('Sign in with GitHub')).toBeVisible();
      // The notice sits inside the card, not past its edges.
      const card = await page.locator('.sam-glass').first().boundingBox();
      const box = await notice.boundingBox();
      expect(box && card).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(card!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(card!.x + card!.width + 1);
      // Above the sign-in buttons, so it is read before anyone signs in.
      const github = await page.getByText('Sign in with GitHub').boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(github!.y);
      await assertNoOverflow(page);
      await screenshot(page, `landing-agent-sign-in-${viewport.name}`);
    });

    test('the agent sign-in notice in the light theme', async ({ page }) => {
      await seedTheme(page, 'light');
      await setupApiMocks(page, { ...ALL_PROVIDERS, agentSignIn: true });
      await page.goto('/');
      await expect(page.getByRole('note')).toBeVisible();
      await assertNoOverflow(page);
      await screenshot(page, `landing-agent-sign-in-light-${viewport.name}`);
    });

    test('an ordinary instance shows no agent sign-in notice', async ({ page }) => {
      await setupApiMocks(page, { ...ALL_PROVIDERS, agentSignIn: false });
      await page.goto('/');
      await expect(page.getByText('Sign in with GitHub')).toBeVisible();
      await expect(page.getByRole('note')).toHaveCount(0);
    });

    test('a remembered answer shows at once while the lookup hangs', async ({ page }) => {
      await setupApiMocks(page, 'hang');
      await page.addInitScript((value) => {
        window.localStorage.setItem('sam:login-providers', value);
      }, JSON.stringify(EMAIL_ONLY));
      await page.goto('/');
      await expect(page.getByRole('textbox', { name: /email/i })).toBeVisible();
      await expect(page.getByRole('status', { name: 'Loading sign-in options' })).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `landing-remembered-${viewport.name}`);
    });

    test('a failed lookup with nothing remembered offers a retry', async ({ page }) => {
      await setupApiMocks(page, 'error');
      await page.goto('/');
      // The hook retries three times with backoff (~7s) before giving up.
      await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.getByText('Sign in with GitHub')).toHaveCount(0);
      await assertNoOverflow(page);
      await screenshot(page, `landing-failed-${viewport.name}`);
    });
  });
}
