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

/**
 * The renderer re-arms requestAnimationFrame every vsync (it only skips drawing to hold 30fps),
 * so an animating hero normally logs 45-60 calls a second. The floor is low on purpose: CPU
 * contention on CI runners can starve frames, while a stopped hero logs exactly zero.
 */
const ANIMATING_MIN_FRAMES = 3;

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
    expect(await framesDuring(page, 1_000)).toBeGreaterThan(ANIMATING_MIN_FRAMES);

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
    expect(await framesDuring(page, 1_000)).toBeGreaterThan(ANIMATING_MIN_FRAMES);
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

/**
 * The hero clips (`overflow: clip`), so a document-level overflow check cannot see a layer
 * cut off at the viewport edge (rule 56). Measure the layers themselves, in the exploded intro
 * and in the resting frame, across the widths the layout steps through.
 */
const LAYOUT_VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 1200, height: 800 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
  { width: 375, height: 667 },
  { width: 360, height: 740 },
];
const HERO_LAYERS = [
  '.hero-copy *',
  '[data-hero-app]',
  '.plane-nodes',
  '.chip',
  '.phone',
  '.phone-chip',
];

async function heroLayout(page: Page) {
  return page.evaluate((layers) => {
    const width = window.innerWidth;
    const cutOff: string[] = [];
    for (const selector of layers) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) {
        if (!element.offsetParent) continue;
        const box = element.getBoundingClientRect();
        if (box.width === 0) continue;
        if (box.left < -1 || box.right > width + 1) {
          cutOff.push(`${selector} spans ${Math.round(box.left)}..${Math.round(box.right)} of ${width}`);
        }
      }
    }
    // Every other clipping container must fit its content; the hero clips its floor by design.
    const clipped: string[] = [];
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      if (element.matches('[data-hero]')) continue;
      const style = getComputedStyle(element);
      if (style.overflowX !== 'hidden' && style.overflowX !== 'clip') continue;
      if (style.textOverflow === 'ellipsis' || element.clientWidth < 4) continue;
      if (element.scrollWidth > element.clientWidth + 1) clipped.push(`${element.tagName}.${element.className}`);
    }
    const copy = document.querySelector('.hero-copy')?.getBoundingClientRect();
    const comment = document.querySelector('.chip-comment')?.getBoundingClientRect();
    return {
      cutOff,
      clipped,
      documentOverflow: document.documentElement.scrollWidth > window.innerWidth,
      // Side by side (>= 1200px), the stage must start right of the copy column.
      overlapsCopy: Boolean(width >= 1200 && copy && comment && comment.left < copy.right),
    };
  }, HERO_LAYERS);
}

test.describe('homepage hero layout', () => {
  test.skip(({ isMobile }) => isMobile, 'viewports are set explicitly; one project is enough');

  for (const viewport of LAYOUT_VIEWPORTS) {
    test(`nothing is cut off at ${viewport.width}px, exploded or at rest`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.goto('/');
      const clean = { cutOff: [], clipped: [], documentOverflow: false, overlapsCopy: false };
      // The intro starts exploded and holds that pose for 1.5s.
      await expect(page.locator('[data-hero]')).toHaveAttribute('data-motion', 'live');
      expect(await heroLayout(page)).toEqual(clean);

      // Pausing composes the resting frame immediately.
      await page.getByRole('button', { name: 'Pause animation' }).click();
      await expect(page.getByRole('button', { name: 'Play animation' })).toBeVisible();
      expect(await heroLayout(page)).toEqual(clean);
    });
  }

  test('switching theme on the page repaints the floor and swaps the layers', async ({ page }) => {
    await useTheme(page, 'dark');
    await page.goto('/');
    const layers = streamingWindow(page);
    const floor = page.locator('[data-hero-field] canvas').first();
    await expect(floor).toBeAttached();
    const darkFloor = await floor.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL());
    expect(await layers.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain('/images/hero/desktop.webp');

    await page.locator('.header').getByRole('button', { name: 'Light theme' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect
      .poll(() => layers.evaluate((el) => getComputedStyle(el).backgroundImage))
      .toContain('/images/hero/desktop-light.webp');
    await expect.poll(() => floor.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL())).not.toBe(darkFloor);
  });

  test('crossing the phone breakpoint swaps the stage and rebuilds the floor once', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    const hero = page.locator('[data-hero]');
    await expect(hero.locator('[data-hero-field] canvas')).toHaveCount(2);
    await expect(hero.locator('.hero-stack')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(hero.locator('.hero-phone')).toBeVisible();
    await expect(hero.locator('.hero-stack')).toBeHidden();
    // The old field was destroyed: still exactly one pair of canvases, and the phone rests composed.
    await expect(hero.locator('[data-hero-field] canvas')).toHaveCount(2);
    await expect(hero.locator('[data-hero-phone-chip]')).not.toHaveClass(/is-hidden/);
  });

  test('the homepage stays under 1,000 elements', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('[data-hero-field] canvas')).toHaveCount(2);
    expect(await page.evaluate(() => document.getElementsByTagName('*').length)).toBeLessThan(1000);
  });
});

test.describe('header menu', () => {
  test('opens, closes on Escape with focus returned, and closes after following a link', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Toggle menu' });
    const menu = page.locator('#mobile-nav');
    await expect(menu).toBeHidden();

    await toggle.click();
    await expect(menu).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toBeFocused();

    await toggle.click();
    await menu.getByRole('link', { name: 'How It Works' }).click();
    await expect(menu).toBeHidden();
    await expect(page).toHaveURL(/#how-it-works$/);
  });
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
