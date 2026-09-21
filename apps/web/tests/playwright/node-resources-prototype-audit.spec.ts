import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { expect, type Page, test } from '@playwright/test';

/**
 * PROTOTYPE audit — node resource-visualisation concepts.
 *
 * The app pins html/body/#root to --sam-app-height with overflow hidden at >=768px,
 * so `fullPage: true` CANNOT grow the capture: the document never scrolls, the page's
 * own container does. A fixed tall viewport is not a fix either — on iteration 1 a
 * 3400px viewport silently cropped the last two node cards out of every screenshot
 * while all ten tests stayed green.
 *
 * `captureBoard` therefore measures the scroll container and resizes the viewport to
 * its content height before capturing, then asserts the container is no longer
 * scrollable — so a future crop fails the test instead of hiding in a green run.
 *
 * A separate describe re-checks the REAL viewports (375x667, 1280x800) and proves the
 * in-container scroll works there.
 *
 * Delete with the prototype.
 */

const OUT = resolve(process.cwd(), '../../.codex/tmp/playwright-screenshots');

const CONCEPTS = [
  { id: 'rails', label: 'A · Capacity rails', slug: 'a-capacity-rails' },
  { id: 'reserved-vs-used', label: 'B · Reserved vs used', slug: 'b-reserved-vs-used' },
  { id: 'ledger', label: 'C · Workspace ledger', slug: 'c-workspace-ledger' },
  { id: 'headroom', label: 'D · Headroom slots', slug: 'd-headroom-slots' },
] as const;

async function openConcept(page: Page, label: string) {
  await page.goto('/prototype/node-resources');
  await expect(page.getByRole('heading', { name: 'Node resource concepts' })).toBeVisible();
  await page.getByRole('button', { name: label }).click();
  await expect(page.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
  // Six real NodeCards must be mounted before anything is measured or captured.
  await expect(page.getByRole('button', { name: /^View node / })).toHaveCount(6);
  await page.waitForTimeout(400);
}

/**
 * Document-level `scrollWidth` cannot see overflow inside an `overflow-x-hidden`
 * ancestor, so this walks clipping elements and measures each one.
 * See .claude/rules/56-clipped-overflow-is-invisible-to-document-checks.md
 */
async function assertNoClippedOverflow(page: Page) {
  const offenders = await page.evaluate(() => {
    const out: Array<{ selector: string; scrollWidth: number; clientWidth: number }> = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const style = getComputedStyle(el);
      const clips = style.overflowX === 'hidden' || style.overflowX === 'clip';
      if (!clips) continue;
      if (style.textOverflow === 'ellipsis') continue;
      if (el.clientWidth < 4) continue;
      if (el.scrollWidth > el.clientWidth + 1) {
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? `.${el.className.trim().split(/\s+/).slice(0, 4).join('.')}`
          : '';
        out.push({
          selector: `${el.tagName.toLowerCase()}${id}${cls}`,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
        });
      }
    }
    return out;
  });
  expect(offenders, `clipped horizontal overflow: ${JSON.stringify(offenders, null, 2)}`).toEqual(
    []
  );

  const documentOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth
  );
  expect(documentOverflow).toBe(false);

  // The prototype scroll container itself must not scroll sideways.
  const container = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-prototype="node-resources"]');
    return el ? { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } : null;
  });
  expect(container).not.toBeNull();
  expect(container!.scrollWidth).toBeLessThanOrEqual(container!.clientWidth + 1);
}

/** Grow the viewport to the scroll container's content, then prove nothing is cropped. */
async function captureBoard(page: Page, width: number, path: string) {
  const measure = () =>
    page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-prototype="node-resources"]');
      return el ? { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null;
    });

  // Growing the viewport reflows the cards, which can change the content height, so
  // iterate to a fixed point rather than trusting the first measurement.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const before = await measure();
    expect(before).not.toBeNull();
    if (before!.scrollHeight <= before!.clientHeight + 1) break;
    await page.setViewportSize({ width, height: Math.min(before!.scrollHeight + 8, 30_000) });
    await page.waitForTimeout(250);
  }

  const after = await measure();
  expect(after).not.toBeNull();
  // The discriminating assertion: iteration 1's 3400px viewport failed exactly here.
  expect(
    after!.scrollHeight,
    'board is taller than the capture viewport — the screenshot is cropped'
  ).toBeLessThanOrEqual(after!.clientHeight + 1);

  await page.waitForTimeout(200);
  await page.screenshot({ path });
}

test.describe('Node resource concepts — mobile 375 (full board)', () => {
  test.use({ viewport: { width: 375, height: 900 }, isMobile: true, hasTouch: true });

  for (const concept of CONCEPTS) {
    test(`${concept.slug} board`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await openConcept(page, concept.label);
      await assertNoClippedOverflow(page);
      await captureBoard(page, 375, `${OUT}/node-viz-${concept.slug}-mobile-375.png`);
    });
  }
});

test.describe('Node resource concepts — desktop 1280 (full board)', () => {
  test.use({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });

  for (const concept of CONCEPTS) {
    test(`${concept.slug} board`, async ({ page }) => {
      mkdirSync(OUT, { recursive: true });
      await openConcept(page, concept.label);
      await assertNoClippedOverflow(page);
      await captureBoard(page, 1280, `${OUT}/node-viz-${concept.slug}-desktop-1280.png`);
    });
  }
});

test.describe('Node resource concepts — real viewports', () => {
  test('mobile 375x667 first screen scrolls inside the container', async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 375, height: 667 });
    await openConcept(page, 'A · Capacity rails');
    await assertNoClippedOverflow(page);
    await page.screenshot({ path: `${OUT}/node-viz-viewport-mobile-375x667-top.png` });

    const scrolled = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-prototype="node-resources"]');
      if (!el) return null;
      el.scrollTop = 900;
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(scrolled).not.toBeNull();
    // A scroll container that cannot scroll is the SessionResourceHistoryDrawer bug.
    expect(scrolled!.scrollHeight).toBeGreaterThan(scrolled!.clientHeight);
    expect(scrolled!.scrollTop).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/node-viz-viewport-mobile-375x667-scrolled.png` });
  });

  test('desktop 1280x800 first screen scrolls inside the container', async ({ page }) => {
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await openConcept(page, 'B · Reserved vs used');
    await assertNoClippedOverflow(page);
    await page.screenshot({ path: `${OUT}/node-viz-viewport-desktop-1280x800-top.png` });

    const scrolled = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-prototype="node-resources"]');
      if (!el) return null;
      el.scrollTop = 700;
      return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    });
    expect(scrolled).not.toBeNull();
    expect(scrolled!.scrollHeight).toBeGreaterThan(scrolled!.clientHeight);
    expect(scrolled!.scrollTop).toBeGreaterThan(0);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/node-viz-viewport-desktop-1280x800-scrolled.png` });
  });
});
