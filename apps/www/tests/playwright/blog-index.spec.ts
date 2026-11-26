import { ADVISORY, advisoryPinnedNow, nearPinBoundary } from './advisory-pin';
import { expect, expectNoOverflowOrSeriousAxeViolations, test } from './fixtures';

/**
 * Blog index (src/pages/blog/index.astro): a post with `pinned: true` in its frontmatter leads the
 * page, ahead of newer posts, until its `pinnedUntil` date; the rest stay in date order. The
 * security advisory is pinned until 2026-12-09, so these tests branch on today's expected state.
 */

test.describe('blog index', () => {
  test.skip(nearPinBoundary, 'the build and this test may straddle the advisory pin end date');

  test('shows the pinned security advisory first, ahead of newer posts, while it is pinned', async ({ page }) => {
    test.skip(!advisoryPinnedNow, 'the advisory pin has ended; covered by the next test');
    await page.goto('/blog/');
    const main = page.locator('main');
    const firstPost = main.locator('a[href^="/blog/"]').first();
    await expect(firstPost).toHaveAttribute('href', ADVISORY);
    await expect(firstPost).toContainText('Pinned · Security advisory');
    await expect(firstPost).toContainText('Check That Your SAM Setup Is Closed');

    // Pinning, not the date, put it there: the grid below starts with a newer post.
    const pinnedDate = await firstPost.locator('time').getAttribute('datetime');
    const gridDates = await main
      .locator('.post-grid time')
      .evaluateAll((els) => els.map((el) => el.getAttribute('datetime') ?? ''));
    expect(gridDates.length).toBeGreaterThan(0);
    expect(gridDates[0] > (pinnedDate ?? '')).toBe(true);
    expect([...gridDates].sort().reverse()).toEqual(gridDates);
    // Shown once: the pinned post is not repeated in the grid.
    await expect(main.locator(`.post-grid a[href="${ADVISORY}"]`)).toHaveCount(0);
  });

  test('lists the advisory in date order once its pin has ended', async ({ page }) => {
    test.skip(advisoryPinnedNow, 'the advisory is still pinned; covered by the previous test');
    await page.goto('/blog/');
    const main = page.locator('main');
    await expect(main.locator('.post-grid a').first()).toBeVisible();
    await expect(main.locator('.pinned-card')).toHaveCount(0);
    await expect(main.locator(`.post-grid a[href="${ADVISORY}"]`)).toHaveCount(1);
    const gridDates = await main
      .locator('.post-grid time')
      .evaluateAll((els) => els.map((el) => el.getAttribute('datetime') ?? ''));
    expect([...gridDates].sort().reverse()).toEqual(gridDates);
  });

  for (const theme of ['dark', 'light'] as const) {
    test(`has no overflow or serious accessibility violations (${theme})`, async ({ page }) => {
      await page.addInitScript(
        (value) => window.localStorage.setItem('starlight-theme', value),
        theme
      );
      await page.goto('/blog/');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect(page.locator('main a[href^="/blog/"]').first()).toBeVisible();
      // Cards fade in on scroll; axe would sample blended mid-transition colours (see marketing-pages.spec.ts).
      await page.addStyleTag({
        content:
          '.animate-on-scroll{opacity:1 !important;transform:none !important;transition:none !important}',
      });
      await page.waitForTimeout(300);
      await expectNoOverflowOrSeriousAxeViolations(page);
    });
  }
});
