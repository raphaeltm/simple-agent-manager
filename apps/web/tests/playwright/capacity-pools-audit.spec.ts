/**
 * Visual audit for the capacity-pool placement prototype (/prototype/capacity-pools).
 *
 * PROTOTYPE-ONLY spec — removed together with the prototype route.
 * Requires the Vite DEV server (the route is gated behind `devOnlyRoutesEnabled()`,
 * so a production preview build will not serve it):
 *
 *   cd apps/web && npx vite --host 0.0.0.0 --port 5173
 *   npx playwright test --config ../../.tmp/capacity-pools/playwright.config.ts
 */

import { expect, test, type Page } from '@playwright/test';

const ROUTE = '/prototype/capacity-pools';
const SHOT_DIR = '../../.codex/tmp/playwright-screenshots';

async function shot(page: Page, name: string) {
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

/** Horizontal overflow is the single most common mobile layout bug. */
async function expectNoOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
}

async function openTab(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.waitForTimeout(300);
}

function suite(viewportName: string) {
  test(`${viewportName} — pool tab`, async ({ page }) => {
    await page.goto(ROUTE);
    await expect(page.getByRole('heading', { name: 'Capacity' })).toBeVisible();
    await expect(page.getByText('How should we choose machines?')).toBeVisible();
    await shot(page, `capacity-pool-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — ladder tab`, async ({ page }) => {
    await page.goto(ROUTE);
    await openTab(page, 'Order');
    await expect(page.getByText('The order we will try')).toBeVisible();
    await shot(page, `capacity-ladder-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — why tab`, async ({ page }) => {
    await page.goto(ROUTE);
    await openTab(page, 'Why');
    await expect(page.getByText('Why this machine?')).toBeVisible();
    await shot(page, `capacity-why-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — providers tab`, async ({ page }) => {
    await page.goto(ROUTE);
    await openTab(page, 'Providers');
    await expect(page.getByText('Connected providers')).toBeVisible();
    await shot(page, `capacity-providers-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — spread strategy reorders the ladder`, async ({ page }) => {
    await page.goto(ROUTE);

    // Behavioural, not cosmetic: switching strategy must change the ranking.
    await openTab(page, 'Order');
    const consolidateFirst = await page.locator('ol li').first().innerText();

    await openTab(page, 'Pool');
    await page.getByRole('button', { name: /Just enough/ }).click();
    await openTab(page, 'Order');
    const spreadFirst = await page.locator('ol li').first().innerText();

    expect(spreadFirst).not.toBe(consolidateFirst);
    // "Pack tight" maximises slots, so it should pick the 8-vCPU machine;
    // "Just enough" minimises hourly spend, so it should pick the 2-vCPU one.
    expect(consolidateFirst).toContain('cx43');
    expect(spreadFirst).toContain('cx23');

    await shot(page, `capacity-ladder-spread-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — losing the cheap provider re-anchors the ceiling instead of emptying the pool`, async ({
    page,
  }) => {
    await page.goto(ROUTE);

    // Untick every Hetzner row. The price ceiling must re-anchor to the cheapest
    // REMAINING option — if it stayed anchored to Hetzner, every survivor would
    // read as "too expensive" and the pool would be permanently empty.
    const hetznerRows = page.locator('label', { hasText: 'Hetzner' });
    const count = await hetznerRows.count();
    for (let i = 0; i < count; i++) {
      const box = hetznerRows.nth(i).locator('input[type="checkbox"]');
      if (await box.isChecked()) await box.uncheck();
    }

    await openTab(page, 'Order');
    const firstAttempt = await page.locator('ol li').first().innerText();
    expect(firstAttempt).not.toContain('Hetzner');
    await expect(page.getByTestId('ladder-empty')).toHaveCount(0);

    await shot(page, `capacity-ladder-no-hetzner-${viewportName}`);
    await expectNoOverflow(page);
  });

  test(`${viewportName} — sold-out cheap capacity queues rather than overspending`, async ({
    page,
  }) => {
    await page.goto(ROUTE);

    // Turn off only Nuremberg — the one Hetzner region that still has stock.
    // Falkenstein/Helsinki remain enabled but sold out, so they keep anchoring
    // the ceiling low, and every survivor is above it. Correct answer: queue.
    const nbg = page.locator('label', { hasText: 'Nuremberg' });
    const count = await nbg.count();
    for (let i = 0; i < count; i++) {
      const box = nbg.nth(i).locator('input[type="checkbox"]');
      if (await box.isChecked()) await box.uncheck();
    }

    await openTab(page, 'Order');
    await expect(page.getByTestId('ladder-empty')).toBeVisible();
    await shot(page, `capacity-ladder-queued-${viewportName}`);

    // Opting into spill must immediately produce an attemptable option.
    await openTab(page, 'Pool');
    await page.getByRole('button', { name: /Start it anywhere/ }).click();
    await openTab(page, 'Order');
    await expect(page.getByTestId('ladder-empty')).toHaveCount(0);
    const spilled = await page.locator('ol li').first().innerText();
    expect(spilled).not.toContain('Hetzner');

    await shot(page, `capacity-ladder-spilled-${viewportName}`);
    await expectNoOverflow(page);
  });
}

test.describe('Capacity pools — mobile', () => {
  suite('mobile-375x667');
});

test.describe('Capacity pools — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });
  suite('desktop-1280x800');
});
