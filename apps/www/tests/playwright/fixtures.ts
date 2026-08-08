import { expect, test as base } from '@playwright/test';

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

export { expect };
export type { Page } from '@playwright/test';
