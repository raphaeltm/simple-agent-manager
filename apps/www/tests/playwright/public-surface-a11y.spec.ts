import AxeBuilder from '@axe-core/playwright';

import { expect, test } from './fixtures';

test('self-host surface has no overflow or serious axe violations', async ({ page }, testInfo) => {
  await page.goto('/self-host/');
  await expect(page.getByRole('heading', { name: 'Deploy your own SAM instance' })).toBeVisible();
  if (!process.env.PLAYWRIGHT_BASE_URL) {
    await expect(page.locator('script[data-api]')).toHaveAttribute(
      'data-api',
      'https://api.localhost/api/t'
    );
  }

  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(hasHorizontalOverflow).toBe(false);

  const axeResults = await new AxeBuilder({ page }).analyze();
  const seriousViolations = axeResults.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);

  const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/www-self-host-${project}.png`,
    fullPage: true,
    animations: 'disabled',
  });
});
