/**
 * Visual + behavioural audit for the Resources-panel prototypes.
 *
 * The production bug these variants address is invisible to a screenshot: the
 * dialog renders correctly, it is simply ~400px taller than the viewport with
 * `overflow: hidden` over the difference. So every claim here is a MEASURED
 * coordinate — the panel box against the viewport box, and the last chunk
 * button's rect against the viewport after scrolling — never `toBeVisible()`.
 *
 * Viewports are pinned per describe, so this spec is run under ONE Playwright
 * project and still covers mobile and desktop:
 *
 *   npx vite --host 0.0.0.0 --port 4173          # DEV server: the prototype
 *                                                # routes are dev-only
 *   npx playwright test resource-panel-prototype-audit \
 *     --project="iPhone SE (375x667)"
 */
import { expect, type Locator, type Page, test } from '@playwright/test';

import {
  assertNoClippedOverflow,
  assertNoOverflow,
  expectThemePoll,
  screenshot,
  seedTheme,
} from './audit-helpers';

const DIR = 'resource-panel-prototypes';

type VariantId = 'a' | 'b' | 'c';
type DatasetId = 'rich' | 'huge' | 'empty' | 'error';

/** Below `md` variant B is a bottom sheet; at and above it, it is variant A's rail. */
function panelTestId(variant: VariantId, mobile: boolean): string {
  if (variant === 'b' && mobile) return 'variant-b-sheet';
  return `variant-${variant}-panel`;
}

function bodyTestId(variant: VariantId, mobile: boolean): string {
  if (variant === 'b' && mobile) return 'variant-b-body';
  return `${panelTestId(variant, mobile)}-body`;
}

async function capture(page: Page, name: string) {
  await screenshot(page, `${DIR}/${name}`);
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
}

async function openVariant(page: Page, variant: VariantId, dataset: DatasetId) {
  await page.goto(`/prototype/resource-panel/${variant}`);
  // Liveness: a crashed page has no rail, no panel and no overflow, so every
  // other assertion here would pass vacuously without this.
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  await expect(page.getByTestId('session-tool-resources')).toBeVisible({ timeout: 20_000 });
  if (dataset !== 'rich') await page.getByTestId(`prototype-dataset-${dataset}`).click();
  await page.waitForTimeout(200);
}

async function openPanel(
  page: Page,
  variant: VariantId,
  mobile: boolean,
  dataset: DatasetId = 'rich'
): Promise<Locator> {
  await openVariant(page, variant, dataset);
  // Entered through the real rail action, not a state setter.
  await page.getByTestId('session-tool-resources').click();
  const panel = page.getByTestId(panelTestId(variant, mobile));
  await expect(panel).toBeVisible();
  await page.waitForTimeout(600);
  return panel;
}

/** Variant B opens at PEEK, where the body is deliberately not scrollable. */
async function expandSheet(page: Page) {
  await page.getByTestId('variant-b-grab-handle').click();
  await page.waitForTimeout(400);
}

async function scrollBodyToBottom(page: Page, variant: VariantId, mobile: boolean) {
  await page.getByTestId(bodyTestId(variant, mobile)).evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page.waitForTimeout(400);
}

/**
 * Every prototype toolbar control must be on screen.
 *
 * `assertNoClippedOverflow` cannot see this: the toolbar was an
 * `overflow-x: auto` scroller, which the detector deliberately exempts, so the
 * 4th dataset button sat off the right edge of a 375px viewport while every
 * overflow assertion stayed green.
 */
async function assertToolbarFullyVisible(page: Page) {
  const last = page.getByTestId('prototype-dataset-error');
  const box = (await last.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(width);
}

/**
 * The chart must fill its card, not letterbox into a square.
 *
 * NOTE on what is measured: the `<svg>`'s own bounding box is `w-full` and
 * therefore ALREADY equals the card's content width with or without
 * `preserveAspectRatio` — measured 323px both ways — so it cannot discriminate.
 * What changes is where the viewBox lands INSIDE that box, so this maps viewBox
 * x=0 and x=100 through `getScreenCTM()`. Pre-fix that span measured 224px (the
 * svg's own height: a centred square) inside a 323px card.
 */
async function assertChartSpansCard(page: Page) {
  const geometry = await page.evaluate(() => {
    const svg = document.querySelector('[data-testid="inspector-chart"] svg') as SVGSVGElement;
    if (!svg) return null;
    const card = svg.parentElement as HTMLElement;
    const style = getComputedStyle(card);
    const ctm = svg.getScreenCTM()!;
    return {
      contentWidth:
        card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      drawnWidth:
        new DOMPoint(100, 0).matrixTransform(ctm).x - new DOMPoint(0, 0).matrixTransform(ctm).x,
      svgBoxWidth: svg.getBoundingClientRect().width,
    };
  });
  expect(geometry, 'the chart svg must be rendered').not.toBeNull();
  // Liveness: the svg box itself still fills the card.
  expect(Math.abs(geometry!.svgBoxWidth - geometry!.contentWidth)).toBeLessThanOrEqual(2);
  // Discriminating: the DRAWN viewBox spans the card rather than a square.
  expect(Math.abs(geometry!.drawnWidth - geometry!.contentWidth)).toBeLessThanOrEqual(2);
}

/** Rect of the LAST chunk button, in viewport coordinates. */
async function lastChunkButtonRect(panel: Locator) {
  return panel.evaluate((el) => {
    const buttons = Array.from(el.querySelectorAll('button')).filter((button) =>
      (button.textContent ?? '').includes('samples')
    );
    const last = buttons.at(-1);
    if (!last) return null;
    const rect = last.getBoundingClientRect();
    return {
      count: buttons.length,
      top: rect.top,
      bottom: rect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
}

/**
 * The Huge dataset is the discriminating case: 24 chunks cannot fit any
 * viewport, so the last button is reachable only if the body genuinely scrolls.
 * On the shipped panel it measured top=943 in a 667px viewport.
 */
async function assertLastChunkReachable(page: Page, variant: VariantId, mobile: boolean) {
  const panel = page.getByTestId(panelTestId(variant, mobile));
  if (variant === 'c') await page.getByTestId('inspector-segment-chunks').click();
  if (variant === 'b' && mobile) await expandSheet(page);
  await page.waitForTimeout(300);

  const body = page.getByTestId(bodyTestId(variant, mobile));
  const before = await body.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  }));
  expect(before.scrollHeight).toBeGreaterThan(before.clientHeight);

  await scrollBodyToBottom(page, variant, mobile);

  const rect = await lastChunkButtonRect(panel);
  expect(rect, 'chunk buttons must render for the Huge dataset').not.toBeNull();
  expect(rect!.count).toBe(24);
  expect(rect!.top).toBeGreaterThanOrEqual(0);
  expect(rect!.bottom).toBeLessThanOrEqual(rect!.viewportHeight + 1);
}

function declareVariantMatrix(mobile: boolean, label: string) {
  for (const variant of ['a', 'b', 'c'] as const) {
    test(`variant ${variant} — closed, rich, huge, empty, error (${label})`, async ({ page }) => {
      await openVariant(page, variant, 'rich');
      await assertToolbarFullyVisible(page);
      await capture(page, `variant-${variant}-closed-${label}`);

      const panel = await openPanel(page, variant, mobile);
      await capture(page, `variant-${variant}-rich-open-${label}`);

      const viewport = page.viewportSize()!;
      if (mobile && variant !== 'b') {
        // (a) Full-screen panels are EXACTLY viewport height — the assertion the
        // shipped panel fails (1069px box in a 667px viewport).
        const box = (await panel.boundingBox())!;
        expect(Math.round(box.height)).toBe(viewport.height);
        expect(Math.round(box.y)).toBe(0);
      }
      if (!mobile) {
        // Desktop: a right rail flush with the right edge.
        const box = (await panel.boundingBox())!;
        expect(Math.round(box.x + box.width)).toBe(viewport.width);
        expect(box.width).toBeLessThanOrEqual(460);
      }

      if (variant === 'b' && mobile) await expandSheet(page);
      if (variant === 'c') await page.getByTestId('inspector-segment-chunks').click();
      await scrollBodyToBottom(page, variant, mobile);
      await capture(page, `variant-${variant}-rich-scrolled-${label}`);

      await openPanel(page, variant, mobile, 'huge');
      if (variant === 'c') await page.getByTestId('inspector-segment-chunks').click();
      if (variant === 'b' && mobile) await expandSheet(page);
      await capture(page, `variant-${variant}-huge-open-${label}`);

      await openPanel(page, variant, mobile, 'huge');
      await assertLastChunkReachable(page, variant, mobile);
      await capture(page, `variant-${variant}-huge-scrolled-${label}`);

      await openPanel(page, variant, mobile, 'empty');
      await expect(page.getByText('No retained resource history is available')).toBeVisible();
      await capture(page, `variant-${variant}-empty-${label}`);

      await openPanel(page, variant, mobile, 'error');
      await expect(page.getByText('Resource history could not be loaded.')).toBeVisible();
      await capture(page, `variant-${variant}-error-${label}`);
    });
  }
}

// ─────────────────────────────── Mobile ───────────────────────────────

test.describe('Resource panel prototypes — mobile', () => {
  test.use({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });

  test('index lists all three variants', async ({ page }) => {
    await page.goto('/prototype/resource-panel');
    await expect(page.getByRole('heading', { name: 'Session Resources panel' })).toBeVisible();
    for (const variant of ['a', 'b', 'c'] as const) {
      const card = page.getByTestId(`prototype-variant-${variant}`);
      const box = (await card.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(56);
    }
    await capture(page, 'index-mobile');
  });

  declareVariantMatrix(true, 'mobile');

  // The app ships a light theme; a prototype that is only legible in dark is a
  // prototype that cannot be evaluated by half the users.
  for (const variant of ['a', 'b', 'c'] as const) {
    test(`variant ${variant} — light theme`, async ({ page }) => {
      await seedTheme(page, 'light');
      const panel = await openPanel(page, variant, true);
      await expectThemePoll(page, 'light');
      // Contrast liveness: the panel must not render as light-on-light.
      const colors = await panel.evaluate((el) => {
        const header = el.querySelector('h2')!;
        return {
          text: getComputedStyle(header).color,
          panel: getComputedStyle(el).backgroundColor,
        };
      });
      expect(colors.text).not.toBe(colors.panel);
      await capture(page, `variant-${variant}-light-mobile`);
    });
  }

  test('variant b — PEEK and FULL snap geometry, and scroll only at FULL', async ({ page }) => {
    const sheet = await openPanel(page, 'b', true);
    const viewportHeight = page.viewportSize()!.height;

    await expect(sheet).toHaveAttribute('data-snap', 'peek');
    const peekBox = (await sheet.boundingBox())!;
    const peekVisible = viewportHeight - peekBox.y;
    expect(peekVisible).toBeGreaterThan(viewportHeight * 0.47);
    expect(peekVisible).toBeLessThan(viewportHeight * 0.57);
    expect(
      await page.getByTestId('variant-b-body').evaluate((el) => getComputedStyle(el).overflowY)
    ).toBe('hidden');
    await capture(page, 'variant-b-snap-peek-mobile');

    // Drag the grab zone upward with a real pointer gesture.
    const dragBox = (await page.getByTestId('variant-b-drag-zone').boundingBox())!;
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + dragBox.width / 2, dragBox.y - 220, { steps: 14 });
    await page.mouse.up();
    await page.waitForTimeout(400);

    await expect(sheet).toHaveAttribute('data-snap', 'full');
    const fullBox = (await sheet.boundingBox())!;
    expect(fullBox.y).toBeGreaterThanOrEqual(0);
    expect(fullBox.y).toBeLessThanOrEqual(16);
    expect(
      await page.getByTestId('variant-b-body').evaluate((el) => getComputedStyle(el).overflowY)
    ).toBe('auto');
    await capture(page, 'variant-b-snap-full-mobile');

    // Dragging the handle back down returns to PEEK rather than dismissing.
    const fullDragBox = (await page.getByTestId('variant-b-drag-zone').boundingBox())!;
    await page.mouse.move(fullDragBox.x + fullDragBox.width / 2, fullDragBox.y + 10);
    await page.mouse.down();
    await page.mouse.move(fullDragBox.x + fullDragBox.width / 2, fullDragBox.y + 240, {
      steps: 14,
    });
    await page.mouse.up();
    await page.waitForTimeout(400);
    await expect(sheet).toHaveAttribute('data-snap', 'peek');
  });

  test('variant c — every segment renders and all 40 windows are reachable', async ({ page }) => {
    await openPanel(page, 'c', true);
    await expect(page.getByTestId('inspector-stat-strip')).toBeVisible();
    // Chart FIRST: the timeline is the default segment, not a chunk list.
    await expect(page.getByRole('img', { name: 'CPU and memory resource timeline' })).toBeVisible();
    await assertChartSpansCard(page);
    // The strip must advertise that it scrolls while cards remain off-screen.
    await expect(page.getByTestId('inspector-stat-strip')).toHaveAttribute('data-has-more', 'true');
    await capture(page, 'variant-c-segment-timeline-mobile');

    await page.getByTestId('inspector-segment-chunks').click();
    await expect(page.getByText('Chunks (3)')).toBeVisible();
    await capture(page, 'variant-c-segment-chunks-mobile');

    await page.getByTestId('inspector-segment-about').click();
    await expect(page.getByText('Correlation is based on concurrent tool windows')).toBeVisible();
    await capture(page, 'variant-c-segment-about-mobile');

    // Selecting a chunk from the Chunks segment switches back to Timeline.
    await page.getByTestId('inspector-segment-chunks').click();
    await page
      .getByRole('button', { name: /samples/ })
      .nth(1)
      .click();
    await expect(page.getByTestId('inspector-chart')).toBeVisible();

    await openPanel(page, 'c', true, 'huge');
    const toggle = page.getByTestId('inspector-toggle-windows');
    await expect(toggle).toHaveText('Show all 40 windows');
    await toggle.click();
    await expect(toggle).toHaveText('Show fewer windows');
    await capture(page, 'variant-c-tool-windows-expanded-mobile');
  });

  test('variant c — the stat strip drops its fade once scrolled to the end', async ({ page }) => {
    await openPanel(page, 'c', true);
    const strip = page.getByTestId('inspector-stat-strip');
    await expect(strip).toHaveAttribute('data-has-more', 'true');
    const masked = await strip.evaluate((el) => getComputedStyle(el).maskImage);
    expect(masked).not.toBe('none');

    await strip.evaluate((el) => {
      el.scrollLeft = el.scrollWidth;
    });
    await page.waitForTimeout(300);
    await expect(strip).toHaveAttribute('data-has-more', 'false');
    expect(await strip.evaluate((el) => getComputedStyle(el).maskImage)).toBe('none');
    await capture(page, 'variant-c-stat-strip-scrolled-mobile');
  });
});

// ─────────────────────────────── Desktop ───────────────────────────────

test.describe('Resource panel prototypes — desktop', () => {
  test.use({ viewport: { width: 1280, height: 800 }, isMobile: false, hasTouch: false });

  test('index', async ({ page }) => {
    await page.goto('/prototype/resource-panel');
    await expect(page.getByRole('heading', { name: 'Session Resources panel' })).toBeVisible();
    await capture(page, 'index-desktop');
  });

  declareVariantMatrix(false, 'desktop');

  test('variant c — the chart spans the full desktop rail card', async ({ page }) => {
    await openPanel(page, 'c', false);
    await expect(page.getByRole('img', { name: 'CPU and memory resource timeline' })).toBeVisible();
    await assertChartSpansCard(page);
    // The 2x2 grid at `md` means nothing is off the right edge, so no fade.
    await expect(page.getByTestId('inspector-stat-strip')).toHaveAttribute(
      'data-has-more',
      'false'
    );
    await capture(page, 'variant-c-chart-desktop');
  });
});
