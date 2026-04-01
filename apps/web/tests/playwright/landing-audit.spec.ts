import { expect, type Page, type Route,test } from '@playwright/test';

// ---------------------------------------------------------------------------
// API Mock — unauthenticated user (no session)
// ---------------------------------------------------------------------------

async function setupApiMocks(page: Page) {
  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    // Auth session — return empty (unauthenticated)
    if (url.includes('/api/auth/get-session')) {
      return route.fulfill({ status: 200, json: {} });
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
// Overflow check helper
// ---------------------------------------------------------------------------

async function assertNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
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

    await assertNoOverflow(page);
    await screenshot(page, 'landing-sign-in-desktop');
  });
});
