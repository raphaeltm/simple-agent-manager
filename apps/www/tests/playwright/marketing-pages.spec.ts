import { expect, expectNoOverflowOrSeriousAxeViolations, test } from './fixtures';

const PAGES: { path: string; slug: string; heading: string | RegExp }[] = [
  { path: '/', slug: 'home', heading: /The open-source platform for/i },
  {
    path: '/features/',
    slug: 'features-index',
    heading: /Everything your team needs/i,
  },
  {
    path: '/features/multiplayer/',
    slug: 'features-multiplayer',
    heading: /Work on projects/i,
  },
];

for (const { path, slug, heading } of PAGES) {
  test(`${path} has no overflow or serious axe violations`, async ({ page }, testInfo) => {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible();

    // Scroll-reveal sections fade in over 0.6s once the IntersectionObserver
    // fires. Neither axe (which samples mid-transition, blended colours) nor a
    // full-page capture waits for that, so settle every section up front.
    await page.addStyleTag({
      content:
        '.animate-on-scroll{opacity:1 !important;transform:none !important;transition:none !important}',
    });
    await page.waitForTimeout(300);

    await expectNoOverflowOrSeriousAxeViolations(page);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-${slug}-${project}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}
