/**
 * Checks every Automation audit runs on a page: no error boundary, no horizontal or clipped
 * overflow, no tap target under 44 px, then a full-page capture. Shared by the Automation and
 * Workflows audits.
 */
import { expect, type Page } from '@playwright/test';

import { assertNoClippedOverflow, assertNoOverflow, screenshot } from './audit-helpers';

/** Interactive elements inside the page content that are shorter than 44 px. */
export async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root =
      document.querySelector('[data-testid="automation-root"]') ?? document.querySelector('main');
    if (!root) return ['no page root'];
    const found: string[] = [];
    for (const element of root.querySelectorAll<HTMLElement>(
      'a[href], button, select, input:not([type="checkbox"]):not([type="hidden"]), summary, [role="radio"]'
    )) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const style = getComputedStyle(element);
      if (style.visibility === 'hidden' || (style.position === 'absolute' && box.width <= 1))
        continue;
      if (box.height < 43.5)
        found.push(
          `${element.tagName.toLowerCase()} "${(element.textContent ?? element.getAttribute('aria-label') ?? '').trim().slice(0, 40)}" ${Math.round(box.height)}px`
        );
    }
    return found;
  });
}

/**
 * The app scrolls inside its own containers, so a full-page screenshot only shows the first
 * screen. Let every scrolling ancestor of the page grow to its content before capturing, so the
 * image shows the whole page (and two different pages can never produce the same image).
 */
export async function expandScrollContainers(page: Page) {
  await page.evaluate(() => {
    // Every ancestor sizes to its content: no scrolling, no fixed screen height, no flex
    // shrinking (the phone layout fits its columns to the screen with flex-1 + min-h-0).
    let node = document.querySelector<HTMLElement>(
      '[data-testid="automation-root"]'
    )?.parentElement;
    while (node) {
      node.style.overflow = 'visible';
      node.style.height = 'auto';
      node.style.maxHeight = 'none';
      node.style.flex = '0 0 auto';
      node = node.parentElement;
    }
    // A sticky footer would freeze where the screen used to end; show it after the content.
    for (const element of document.querySelectorAll<HTMLElement>(
      '[data-testid="automation-root"] *'
    ))
      if (getComputedStyle(element).position === 'sticky') element.style.position = 'static';
  });
}

export async function audit(page: Page, name: string) {
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  // Layout checks run on the real, scrolling layout; only the capture is expanded.
  await assertNoOverflow(page);
  await assertNoClippedOverflow(page);
  expect(await smallTargets(page)).toEqual([]);
  await expandScrollContainers(page);
  await screenshot(page, name);
}
