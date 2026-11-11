import { expect, type Page, test } from './fixtures';

/**
 * Homepage (src/components/factory/): real SAM screens in both themes, stages that play once and
 * rest, and a phone layout with phone-width captures. Every case enters the way a visitor does:
 * page load, scrolling, the reduced-motion preference, the theme, the viewport.
 */

const FACTORY_IMAGES = '/images/factory/';

async function useTheme(page: Page, theme: 'dark' | 'light') {
  await page.addInitScript((value) => window.localStorage.setItem('starlight-theme', value), theme);
}

/** Scrolls through the whole page the way a reader would, so every lazy screen loads and plays. */
async function scrollThrough(page: Page) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 400) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(60);
  }
}

/** Running animations inside the homepage content (the shared header's own transitions excluded). */
const runningAnimations = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main.fh');
    return document.getAnimations().filter((a) => {
      const target = (a.effect as KeyframeEffect | null)?.target;
      return a.playState === 'running' && Boolean(main && target && main.contains(target));
    }).length;
  });

test.describe('homepage', () => {
  test('leads with the promise and a real SAM screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('operating system for scalable software factories');
    await expect(page.getByRole('img', { name: /The SAM home screen/ })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: 'Deploy SAM' }).first()).toHaveAttribute('href', '/self-host/');
    await expect(page.getByRole('link', { name: 'See how work moves' })).toHaveAttribute('href', '#how-work-moves');
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`downloads only the ${theme} theme's screens`, async ({ page }) => {
      await useTheme(page, theme);
      const requested: string[] = [];
      page.on('request', (request) => {
        const { pathname } = new URL(request.url());
        if (pathname.startsWith(FACTORY_IMAGES)) requested.push(pathname);
      });
      await page.goto('/');
      await scrollThrough(page);
      await expect.poll(() => requested.length).toBeGreaterThan(5);
      const wrongTheme = requested.filter((path) => path.endsWith('-light.webp') !== (theme === 'light'));
      expect(wrongTheme).toEqual([]);
    });
  }

  test('the rail follows the stage being read', async ({ page }) => {
    await page.goto('/');
    await page.locator('#stage-build').scrollIntoViewIfNeeded();
    await page.evaluate(() => {
      const stage = document.querySelector('#stage-build');
      if (stage) window.scrollTo(0, stage.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2 + 100);
    });
    const rail = page.getByRole('navigation', { name: 'Stages of the process' });
    await expect(rail.locator('[aria-current="step"]')).toHaveAttribute('href', '#stage-build');
  });

  test('a stage plays once and then rests', async ({ page }) => {
    await page.goto('/');
    // Bring the picture itself onto the screen; on phones it sits below the copy.
    await page.evaluate(() => {
      const figure = document.querySelector('#stage-idea [data-play]');
      if (figure) window.scrollTo(0, figure.getBoundingClientRect().top + window.scrollY - window.innerHeight / 4);
    });
    const figure = page.locator('#stage-idea [data-play]');
    await expect(figure).toHaveClass(/is-in/);
    // The ring pulses and the note lands, then nothing is left running (WCAG 2.2.2: under 5 s).
    await expect.poll(() => runningAnimations(page), { timeout: 6_000 }).toBe(0);
    await expect(page.locator('#stage-idea .stage-note')).toHaveCSS('opacity', '1');
  });

  test('reduced motion shows every resting frame with nothing animating', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const hidden = await page.evaluate(
      () => [...document.querySelectorAll('.fh [data-reveal]')].filter((el) => getComputedStyle(el).opacity !== '1').length,
    );
    expect(hidden).toBe(0);
    await expect(page.locator('#stage-ship .stage-note')).toHaveCSS('opacity', '1');
    expect(await runningAnimations(page)).toBe(0);
  });

  test('phones get phone-width captures, desktops the full screens', async ({ page }) => {
    await page.goto('/');
    const phone = (page.viewportSize()?.width ?? 1280) < 768;
    const figure = page.locator('#stage-shape .stage-figure');
    await figure.scrollIntoViewIfNeeded();
    await expect(figure.locator('.stage-phone')).toBeVisible({ visible: phone });
    await expect(figure.locator('.stage-desk')).toBeVisible({ visible: !phone });
    await expect(figure.locator('.stage-inset')).toBeVisible({ visible: !phone });
  });

  test('every stage picture fits the viewport', async ({ page }) => {
    await page.goto('/');
    const overflow = await page.evaluate(() => {
      const width = document.documentElement.clientWidth;
      return [...document.querySelectorAll('.stage-frame, .floor-frame, .fh-screen')]
        .map((el) => el.getBoundingClientRect())
        .filter((box) => box.left < -1 || box.right > width + 1).length;
    });
    expect(overflow).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)).toBe(false);
  });

  test('the homepage stays under 1,000 elements', async ({ page }) => {
    await page.goto('/');
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
    await expect(page).toHaveURL(/#how-work-moves$/);
  });
});

test.describe('themed screenshots', () => {
  for (const path of ['/features/', '/enterprise/cost-control/']) {
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
