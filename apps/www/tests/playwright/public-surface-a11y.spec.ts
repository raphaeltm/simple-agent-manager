import { expect, expectNoOverflowOrSeriousAxeViolations, test } from './fixtures';

test('self-host surface has no overflow or serious axe violations', async ({ page }, testInfo) => {
  await page.goto('/self-host/');
  await expect(page.getByRole('heading', { name: 'Deploy your own SAM instance' })).toBeVisible();
  if (!process.env.PLAYWRIGHT_BASE_URL) {
    await expect(page.locator('script[data-api]')).toHaveAttribute(
      'data-api',
      'https://api.localhost/api/t'
    );
  }

  await expectNoOverflowOrSeriousAxeViolations(page);

  const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
  await page.screenshot({
    path: `../../.codex/tmp/playwright-screenshots/www-self-host-${project}.png`,
    fullPage: true,
    animations: 'disabled',
  });
});
