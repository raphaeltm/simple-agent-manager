import { expect, type Page, test } from './fixtures';

/**
 * Homepage hero: the real-UI stack (desktop) or phone (mobile) over the glass node floor.
 * Every case enters the way a visitor does — page load, the reduced-motion preference,
 * the pause button, the theme — and never sets the hero's state directly.
 */

const HERO_IMAGES = '/images/hero/';

/** Counts requestAnimationFrame calls so a test can tell whether anything is animating. */
async function countFrames(page: Page) {
  await page.addInitScript(() => {
    const original = window.requestAnimationFrame.bind(window);
    const counter = window as unknown as { __rafCalls: number };
    counter.__rafCalls = 0;
    window.requestAnimationFrame = (callback) => {
      counter.__rafCalls += 1;
      return original(callback);
    };
  });
}

async function framesDuring(page: Page, ms: number) {
  const read = () => page.evaluate(() => (window as unknown as { __rafCalls: number }).__rafCalls);
  const before = await read();
  await page.waitForTimeout(ms);
  return (await read()) - before;
}

async function useTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => window.localStorage.setItem('starlight-theme', value), theme);
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 1280) < 700;
const streamingWindow = (page: Page) =>
  page.locator(`[data-streaming-window="${isMobile(page) ? 'phone' : 'desktop'}"]`);

/** The strip's translate offsets the page will step through, read from the rendered markup. */
async function stripOffsets(page: Page): Promise<number[]> {
  const parsed: unknown = JSON.parse((await streamingWindow(page).getAttribute('data-offsets')) ?? '[]');
  return Array.isArray(parsed) ? parsed.filter((value): value is number => typeof value === 'number') : [];
}

test.describe('homepage hero', () => {
  test('plays the intro: assembles, streams, needs input, then completes', async ({ page }) => {
    await page.goto('/');
    const hero = page.locator('[data-hero]');
    await expect(hero).toHaveAttribute('data-motion', 'live');
    await expect(hero.locator('[data-hero-field] canvas')).toHaveCount(2);

    const strip = streamingWindow(page).locator('[data-sw-strip]');
    const offsets = await stripOffsets(page);
    expect(offsets.length).toBeGreaterThan(1);
    const [first, last] = [offsets[0], offsets.at(-1)];

    // The transcript starts pushed down and ends on the real frame.
    await expect(strip).toHaveAttribute('style', new RegExp(`--sw-offset: ${first}%`));
    await expect(strip).toHaveAttribute('style', new RegExp(`--sw-offset: ${last}%`), { timeout: 12_000 });

    if (isMobile(page)) {
      await expect(hero.locator('[data-hero-phone-chip]')).not.toHaveClass(/is-hidden/, { timeout: 12_000 });
      await expect(hero.locator('.hero-phone')).toBeVisible();
      await expect(hero.locator('.hero-stack')).toBeHidden();
      return;
    }

    const stack = hero.locator('[data-hero-stack]');
    await expect(stack).not.toHaveClass(/is-exploded/, { timeout: 4_000 });
    await expect(stack).toHaveAttribute('data-notify', 'input', { timeout: 8_000 });
    await expect(hero).toHaveAttribute('data-alert', 'input');
    await expect(stack).toHaveAttribute('data-notify', 'done', { timeout: 6_000 });
    await expect(hero).not.toHaveAttribute('data-alert', 'input');
    await expect(hero.locator('.chip-notify-done')).toHaveCSS('opacity', '1', { timeout: 2_000 });
  });

  test('the pause control stops all hero motion and replays on play', async ({ page }) => {
    await countFrames(page);
    await page.goto('/');
    const hero = page.locator('[data-hero]');
    const toggle = hero.getByRole('button', { name: 'Pause animation' });
    await expect(toggle).toBeVisible();
    expect(await framesDuring(page, 1_000)).toBeGreaterThan(10);

    await toggle.click();
    const play = hero.getByRole('button', { name: 'Play animation' });
    await expect(play).toBeVisible();
    // Paused means the resting frame, held still: no animation frames at all.
    if (!isMobile(page)) {
      await expect(hero.locator('[data-hero-stack]')).toHaveAttribute('data-notify', 'done');
      await expect(hero.locator('[data-hero-stack]')).not.toHaveClass(/is-exploded/);
    }
    expect(await framesDuring(page, 1_000)).toBe(0);

    await play.click();
    await expect(hero.getByRole('button', { name: 'Pause animation' })).toBeVisible();
    if (!isMobile(page)) await expect(hero.locator('[data-hero-stack]')).toHaveClass(/is-exploded/);
    expect(await framesDuring(page, 1_000)).toBeGreaterThan(10);
  });

  test('reduced motion shows the composed frame with nothing animating', async ({ page }) => {
    await countFrames(page);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const hero = page.locator('[data-hero]');
    await expect(hero).toHaveAttribute('data-motion', 'live');
    // Liveness: the floor was drawn and the copy rendered.
    await expect(hero.locator('[data-hero-field] canvas')).toHaveCount(2);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

    await expect(hero.locator('[data-hero-toggle]')).toBeHidden();
    if (!isMobile(page)) {
      await expect(hero.locator('[data-hero-stack]')).toHaveAttribute('data-notify', 'done');
      await expect(hero.locator('[data-hero-stack]')).not.toHaveClass(/is-exploded/);
    }
    await page.waitForTimeout(500);
    expect(await framesDuring(page, 1_000)).toBe(0);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`downloads only the ${theme} theme's hero layers`, async ({ page }) => {
      const requested: string[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith(HERO_IMAGES)) requested.push(url.pathname);
      });
      await useTheme(page, theme);
      await page.goto('/');
      const frame = streamingWindow(page);
      await expect(frame).toBeVisible();
      await page.waitForLoadState('networkidle');

      const base = isMobile(page) ? 'phone' : 'desktop';
      const expected = `${HERO_IMAGES}${base}${theme === 'light' ? '-light' : ''}.webp`;
      expect(await frame.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(expected);
      expect(requested).toContain(expected);
      expect(requested.filter((path) => path.endsWith('-light.webp') !== (theme === 'light'))).toEqual([]);
      // Phones never fetch the desktop stack, and desktops never fetch the phone.
      const other = isMobile(page) ? 'desktop' : 'phone';
      expect(requested.filter((path) => path.startsWith(`${HERO_IMAGES}${other}`))).toEqual([]);
    });
  }
});

test.describe('themed screenshots', () => {
  for (const path of ['/', '/features/', '/enterprise/cost-control/']) {
    for (const theme of ['dark', 'light'] as const) {
      test(`${path} shows exactly one screenshot per pair in ${theme}`, async ({ page }) => {
        await useTheme(page, theme);
        await page.goto(path);
        const pairs = await page.evaluate(() =>
          [...document.querySelectorAll('picture.shot-dark')].map((dark) => {
            const light = dark.nextElementSibling;
            const shown = (el: Element | null) => Boolean(el) && getComputedStyle(el as Element).display !== 'none';
            return { dark: shown(dark), light: shown(light) };
          }),
        );
        expect(pairs.length).toBeGreaterThan(0);
        for (const pair of pairs) {
          expect(pair).toEqual(theme === 'light' ? { dark: false, light: true } : { dark: true, light: false });
        }
      });
    }
  }
});
