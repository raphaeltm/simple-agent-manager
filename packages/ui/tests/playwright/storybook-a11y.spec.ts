import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

const stories = [
  'components-button--primary',
  'components-button--secondary',
  'components-button--loading',
  'components-button--danger',
  'components-statusbadge--running',
  'components-statusbadge--creating',
  'components-statusbadge--disconnected',
  'components-statusbadge--mobile-label',
] as const;

const themes = ['sam', 'sam-light'] as const;

for (const theme of themes) {
  for (const story of stories) {
    test(`${story} renders without overflow or serious axe violations in ${theme}`, async ({
      page,
    }, testInfo) => {
      const query = new URLSearchParams({
        id: story,
        globals: `theme:${theme}`,
        viewMode: 'story',
      });
      await page.goto(`/iframe.html?${query.toString()}`);
      await expect(page.locator('#storybook-root')).not.toBeEmpty();

      const hasHorizontalOverflow = await page.evaluate(
        () => document.documentElement.scrollWidth > document.documentElement.clientWidth
      );
      expect(hasHorizontalOverflow).toBe(false);

      const axeResults = await new AxeBuilder({ page }).include('#storybook-root').analyze();
      const seriousViolations = axeResults.violations.filter(
        (violation) => violation.impact === 'critical' || violation.impact === 'serious'
      );
      expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);

      const project = testInfo.project.name.toLowerCase().replace(/\W+/g, '-');
      await page.screenshot({
        path: `../../.codex/tmp/playwright-screenshots/storybook-${story}-${theme}-${project}.png`,
        fullPage: true,
        animations: 'disabled',
      });
    });
  }
}
