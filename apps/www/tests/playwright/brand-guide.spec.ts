import { expect, expectNoOverflowOrSeriousAxeViolations, test } from './fixtures';

const PATH = '/brand/';

test.describe('brand guide', () => {
  test('final frame has no overflow or serious axe violations, and stays out of search', async ({
    page,
  }, testInfo) => {
    // A long page: axe and the full-page capture together outlast the default timeout on phones.
    test.slow();
    // Reduced motion renders every section's resting frame, so axe never samples a fade.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(PATH);
    await expect(
      page.getByRole('heading', { level: 1, name: /How SAM looks, sounds and moves/ })
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
    await expect(page.locator('html')).not.toHaveClass(/bg-motion/);
    // Liveness: the last section rendered too.
    await expect(page.getByRole('heading', { name: 'Take what you need' })).toBeVisible();

    await expectNoOverflowOrSeriousAxeViolations(page);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-brand-${project}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });

  test('sections reveal as they scroll into view', async ({ page }) => {
    await page.goto(PATH);
    await expect(page.locator('html')).toHaveClass(/bg-motion/);
    // At the top of the page the hero is at rest, not part-way through its scroll motion.
    const hero = page.locator('.bg-hero');
    await expect.poll(() => hero.evaluate((el) => el.style.getPropertyValue('--p'))).toBe('0.0000');
    const heading = page.locator('#voice-title');
    await expect(heading).not.toHaveClass(/is-in/);
    await heading.scrollIntoViewIfNeeded();
    await expect(heading).toHaveClass(/is-in/);

    // Wipes start clipped to nothing, which an ordinary reveal threshold never sees.
    const share = page.locator('.bg-share');
    await expect(share).not.toHaveClass(/is-in/);
    await share.scrollIntoViewIfNeeded();
    await expect(share).toHaveClass(/is-in/);
  });

  test('copies a colour value from its swatch', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'clipboard permissions are Chromium-only');
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(PATH);
    const button = page.getByRole('button', { name: 'Copy Tile Green hex #004222' });
    await button.click();
    await expect(button).toHaveAttribute('data-copied', '');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('#004222');
    await expect(page.locator('[data-copy-status]')).toHaveText('Copied #004222');
  });

  test('clear-space guides and the weight slider respond', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(PATH);
    const toggle = page.getByRole('button', { name: 'Show clear space' });
    const stage = page.locator('#logo-stage');
    await expect(stage).not.toHaveAttribute('data-on');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(stage).toHaveAttribute('data-on', '');

    const word = page.locator('#specimen-word');
    await expect(word).toHaveCSS('font-weight', '600');
    await page.getByLabel('Weight').fill('300');
    await expect(word).toHaveCSS('font-weight', '300');
  });

  test('colour track pins and slides on wide screens, and stays a grid on phones', async ({
    page,
  }, testInfo) => {
    await page.goto(PATH);
    const pin = page.locator('[data-pin]');
    const track = page.locator('[data-pin-track]');
    if (testInfo.project.name.includes('Mobile')) {
      await expect(pin).not.toHaveAttribute('data-pinned');
      return;
    }
    await expect(pin).toHaveAttribute('data-pinned', '');
    const top = await pin.evaluate((el) => el.getBoundingClientRect().top + window.scrollY);
    const travel = await pin.evaluate((el) => el.offsetHeight - window.innerHeight);
    expect(travel).toBeGreaterThan(200);

    const shiftAt = async (fraction: number) => {
      await page.evaluate((y) => window.scrollTo(0, y), top + travel * fraction);
      await page.waitForTimeout(200);
      return track.evaluate((el) => new DOMMatrixReadOnly(getComputedStyle(el).transform).m41);
    };
    const start = await shiftAt(0.05);
    const end = await shiftAt(0.95);
    expect(end).toBeLessThan(start - 200);
  });

  test('tabbing to an off-screen swatch scrolls the pinned track to it', async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name.includes('Mobile'), 'the track only pins on wide screens');
    await page.goto(PATH);
    await expect(page.locator('[data-pin]')).toHaveAttribute('data-pinned', '');
    const last = page.getByRole('button', { name: 'Copy Forest Ink hex #11271d' });
    await last.focus();
    await page.waitForTimeout(250);
    const box = await last.boundingBox();
    const viewport = page.viewportSize()!;
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
  });
});
