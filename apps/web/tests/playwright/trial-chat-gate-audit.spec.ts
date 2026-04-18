/**
 * Playwright visual audit for Wave-1 Track D components.
 *
 * Exercises ChatGate + LoginSheet through the `/__test/trial-chat-gate`
 * harness page with query-param-driven scenarios:
 *   - chip counts: 0, 1, 5, 20
 *   - long-text variant (title/summary wrapping)
 *   - LoginSheet open/closed
 *   - anonymous (forceAnonymous) vs authenticated flow
 *
 * Rule 17 requires mobile (375×667) and desktop (1280×800) coverage plus an
 * overflow assertion per scenario.
 */
import { expect, type Page, test } from '@playwright/test';

const HARNESS = '/__test/trial-chat-gate';

// Rule 17 mandates mobile (375×667) and desktop (1280×800) coverage. The
// describes below override the viewport via `test.use`, so we pin the run to
// the iPhone SE project — otherwise the Desktop-project run inherits 1280×800
// for the "Mobile" describe and overwrites the mobile screenshots. Running
// against multiple base projects duplicates work without adding coverage.
test.describe.configure({ mode: 'serial' });

async function screenshot(page: Page, name: string) {
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/${name}.png`,
    fullPage: true,
  });
}

async function assertNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow, 'page should not have horizontal overflow').toBe(false);
}

// ---------------------------------------------------------------------------
// Mobile (default project: iPhone SE 375×667)
// ---------------------------------------------------------------------------

test.describe('Trial ChatGate — Mobile', () => {
  test('no chips, empty state', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=0`);
    await expect(page.getByTestId('trial-chat-gate')).toBeVisible();
    await expect(page.getByTestId('trial-chat-gate-chips')).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-empty-mobile');
  });

  test('single chip', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=1`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-single-chip-mobile');
  });

  test('five chips — typical case', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=5`);
    for (let i = 0; i < 5; i++) {
      await expect(page.getByTestId(`suggestion-chip-idea-${i}`)).toBeVisible();
    }
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-five-chips-mobile');
  });

  test('twenty chips — overflow scrolls horizontally, not the page', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=20`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    // The chip row has its own horizontal scroll — but the PAGE must not.
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-twenty-chips-mobile');
  });

  test('long chip text wraps and truncates cleanly', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=3&long=1`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-long-text-mobile');
  });

  test('anonymous send opens LoginSheet', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=3`);
    await page.getByTestId('trial-chat-input').fill('please help me explore');
    await page.getByTestId('trial-chat-send').click();
    await expect(page.getByTestId('trial-login-sheet')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-login-sheet-mobile');
  });

  test('LoginSheet bottom-sheet layout via loginOpen flag', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=3&loginOpen=1`);
    await expect(page.getByTestId('trial-login-sheet')).toBeVisible();
    await expect(page.getByTestId('trial-login-github')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-login-sheet-open-mobile');
  });

  test('touch target size — send button is at least 44px', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=1`);
    const send = page.getByTestId('trial-chat-send');
    const box = await send.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  });

  test('touch target size — suggestion chip is at least 44px tall', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=1`);
    const chip = page.getByTestId('suggestion-chip-idea-0');
    const box = await chip.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  });
});

// ---------------------------------------------------------------------------
// Desktop (1280×800)
// ---------------------------------------------------------------------------

test.describe('Trial ChatGate — Desktop', () => {
  test.use({
    viewport: { width: 1280, height: 800 },
    isMobile: false,
    hasTouch: false,
  });

  test('five chips on desktop', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=5`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-five-chips-desktop');
  });

  test('twenty chips scroll container on desktop', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=20`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-twenty-chips-desktop');
  });

  test('long chip text on desktop', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=3&long=1`);
    await expect(page.getByTestId('suggestion-chip-idea-0')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-chat-gate-long-text-desktop');
  });

  test('LoginSheet centered modal layout on desktop', async ({ page }) => {
    await page.goto(`${HARNESS}?ideas=3&loginOpen=1`);
    await expect(page.getByTestId('trial-login-sheet')).toBeVisible();
    await expect(page.getByTestId('trial-login-github')).toBeVisible();
    await assertNoHorizontalOverflow(page);
    await screenshot(page, 'trial-login-sheet-open-desktop');
  });
});
