import { expect, type Page } from './fixtures';

/**
 * Strong overflow assertion: compares the actual page content width against the
 * configured CSS viewport width from Playwright.
 *
 * The document-level `scrollWidth <= innerWidth` check is insufficient because
 * `overflow-x:hidden` on ancestor containers causes both to expand together,
 * making the comparison a tautology. Instead, we measure the body's scroll
 * content against the viewport the test was configured with.
 */
export async function expectNoHorizontalOverflow(page: Page) {
  const cssViewportWidth = page.viewportSize()!.width;

  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);

  expect(
    scrollWidth,
    `document scrollWidth ${scrollWidth}px exceeds CSS viewport ${cssViewportWidth}px`
  ).toBeLessThanOrEqual(cssViewportWidth);
}

/**
 * Assert that every dd value inside the preview definition list fits within
 * the CSS viewport width. Catches mobile overflow where grid tracks expand
 * past the viewport due to long monospace URL values.
 */
export async function assertPreviewValuesWithinViewport(page: Page) {
  const cssViewportWidth = page.viewportSize()!.width;

  const rects = await page.locator('#sh-app-preview dd').evaluateAll((dds) =>
    dds.map((dd) => {
      const r = dd.getBoundingClientRect();
      return {
        right: r.right,
        width: r.width,
        client: dd.clientWidth,
        scroll: dd.scrollWidth,
        text: dd.textContent?.slice(0, 40) ?? '',
      };
    })
  );

  expect(rects.length).toBeGreaterThan(0);

  for (const rect of rects) {
    expect(
      rect.right,
      `preview dd "${rect.text}" right edge ${rect.right}px exceeds viewport ${cssViewportWidth}px`
    ).toBeLessThanOrEqual(cssViewportWidth);
    expect(rect.scroll, `preview dd "${rect.text}" must not hide clipped text`).toBeLessThanOrEqual(
      rect.client + 1
    );
  }
}
