import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

const PAGES: { path: string; slug: string; heading: string | RegExp }[] = [
  { path: '/', slug: 'home', heading: /Run coding agents as a team/i },
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

    const hasHorizontalOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    );
    expect(hasHorizontalOverflow).toBe(false);

    const axeResults = await new AxeBuilder({ page }).analyze();
    const seriousViolations = axeResults.violations.filter(
      (violation) => violation.impact === 'critical' || violation.impact === 'serious'
    );
    expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);

    // Scroll-reveal sections stay at opacity 0 until the IntersectionObserver
    // fires, which a full-page capture does not wait for. Reveal them so the
    // screenshot shows the real page content, not blank sections.
    await page.addStyleTag({
      content: '.animate-on-scroll{opacity:1 !important;transform:none !important;transition:none !important}',
    });
    await page.waitForTimeout(300);

    const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
    await page.screenshot({
      path: `../../.codex/tmp/playwright-screenshots/www-${slug}-${project}.png`,
      fullPage: true,
      animations: 'disabled',
    });
  });
}
