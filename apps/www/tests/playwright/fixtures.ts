import AxeBuilder from '@axe-core/playwright';
import { expect, type Page, test as base } from '@playwright/test';

const PRODUCTION_ANALYTICS_ORIGIN = 'https://api.simple-agent-manager.org';

export const test = base.extend<{ productionAnalyticsIsolation: void }>({
  productionAnalyticsIsolation: [
    async ({ page }, use) => {
      const productionAnalyticsRequests: string[] = [];
      await page.route(`${PRODUCTION_ANALYTICS_ORIGIN}/api/t*`, async (route) => {
        productionAnalyticsRequests.push(route.request().url());
        await route.abort('blockedbyclient');
      });

      await use();

      expect(
        productionAnalyticsRequests,
        'browser quality tests must not write synthetic analytics to production'
      ).toEqual([]);
    },
    { auto: true },
  ],
});

/**
 * Shared public-surface quality gate: no horizontal document overflow and no
 * serious/critical axe violations on the current page.
 */
export async function expectNoOverflowOrSeriousAxeViolations(page: Page): Promise<void> {
  const hasHorizontalOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(hasHorizontalOverflow).toBe(false);

  const axeResults = await new AxeBuilder({ page }).analyze();
  const seriousViolations = axeResults.violations.filter(
    (violation) => violation.impact === 'critical' || violation.impact === 'serious'
  );
  expect(seriousViolations, JSON.stringify(seriousViolations, null, 2)).toEqual([]);
}

export { expect };
export type { Page } from '@playwright/test';
