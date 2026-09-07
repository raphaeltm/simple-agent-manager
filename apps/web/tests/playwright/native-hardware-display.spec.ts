import { mkdirSync } from 'node:fs';

import { expect, test } from '@playwright/test';

test.skip(
  !process.env.NATIVE_HARDWARE_BROWSER_AUDIT,
  'Run with playwright.native-hardware.config.ts: real-component harness requires the Vite module server'
);

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status !== testInfo.expectedStatus) {
    await testInfo.attach('rendered-body', {
      body: await page.locator('body').innerText(),
      contentType: 'text/plain',
    });
    console.log('FAILED SURFACE BODY:', await page.locator('body').innerText());
  }
});

const surfaces = [
  'node-card',
  'node-detail',
  'workspace-card',
  'workspace-sidebar',
  'session-infrastructure',
  'deployment',
  'usage',
  'admin-usage',
];
const scenarios = ['normal', 'legacy', 'long', 'empty', 'many', 'error'];
const period = {
  start: '2026-09-01',
  end: '2026-10-01',
  totalNodeHours: 10,
  totalVcpuHours: 20,
  platformNodeHours: 10,
  platformVcpuHours: 20,
  userNodeHours: 0,
  userVcpuHours: 0,
  activeNodes: 1,
  activeWorkspaces: 1,
};
for (const surface of surfaces) {
  for (const scenario of scenarios) {
    test(`${surface} ${scenario}`, async ({ page }, testInfo) => {
      test.skip(
        testInfo.project.name.startsWith('Narrow') && scenario !== 'normal',
        '320px checks normal layout; full stress matrix runs at 375px and desktop'
      );
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/native-hardware-audit?**', (route) =>
        route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script type="module">import RefreshRuntime from '/@react-refresh'; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/tests/playwright/fixtures/native-hardware-harness.tsx"></script></body></html>`,
        })
      );
      await page.route('**/api/**', (route) => {
        const path = new URL(route.request().url()).pathname;
        if (!path.startsWith('/api/')) return route.continue();
        if (
          scenario === 'error' &&
          (path === '/api/usage/compute' || path.startsWith('/api/admin/usage/nodes/'))
        ) {
          return route.fulfill({
            status: 500,
            json: { error: 'INTERNAL_ERROR', message: 'Compute usage unavailable' },
          });
        }
        const hardware =
          scenario === 'legacy'
            ? {}
            : {
                providerInstanceType: 'cx53',
                providerInstanceVcpuCount: 16,
                providerInstanceMemoryMb: 32768,
                providerInstanceDiskGb: 320,
                observedProviderInstanceType: 'cx53',
                observedProviderInstanceVcpuCount: 12,
                observedProviderInstanceMemoryMb: 30720,
                observedProviderInstanceDiskGb: 300,
              };
        const session = {
          nodeId: 'native-node',
          workspaceId: 'native-workspace',
          name: scenario === 'long' ? 'Compute 🚀 <script> '.repeat(20) : 'Native compute',
          vmSize: 'small',
          vcpuCount: 2,
          serverType: 'legacy',
          credentialSource: 'platform',
          status: 'running',
          createdAt: '2026-09-07',
          startedAt: '2026-09-07',
          vmLocation: 'nbg1',
          workspaceCount: 1,
          ...hardware,
        };
        const sessions =
          scenario === 'empty'
            ? []
            : Array.from({ length: scenario === 'many' ? 35 : 1 }, (_, i) => ({
                ...session,
                nodeId: `node-${i}`,
              }));
        let body: unknown = {};
        if (path.includes('/capacity-pools/defaults'))
          body = {
            effectiveSummary: {
              scope: 'installation',
              state:
                scenario === 'empty'
                  ? 'configured-empty'
                  : scenario === 'error'
                    ? 'catalog-unavailable'
                    : 'configured-ready',
              strategy: 'pack',
              exhaustionPolicy: 'queue',
              availableCandidateCount: scenario === 'empty' ? 0 : 3,
            },
            defaults: [{ summary: { credentialId: 'SECRET-MUST-NOT-RENDER' } }],
          };
        else if (path === '/api/usage/compute')
          body = { currentPeriod: period, activeSessions: sessions };
        else if (path === '/api/usage/quota')
          body = { monthlyVcpuHoursLimit: null, byocExempt: false };
        else if (path.startsWith('/api/admin/usage/nodes/')) body = { ...period, nodes: sessions };
        else if (path === '/api/usage/ai') body = { totalRequests: 0 };
        else if (path === '/api/usage/ai/budget')
          body = {
            settings: {
              dailyInputTokenLimit: null,
              dailyOutputTokenLimit: null,
              monthlyCostCapUsd: null,
              alertThresholdPercent: 80,
            },
            isCustom: false,
            dailyUsage: { inputTokens: 0, outputTokens: 0 },
            effectiveLimits: { dailyInputTokenLimit: 500000, dailyOutputTokenLimit: 200000 },
            monthCostUsd: 0,
            utilization: { dailyInputPercent: 0, dailyOutputPercent: 0, monthlyCostPercent: null },
            exceeded: false,
          };
        return route.fulfill({ json: body });
      });
      await page.goto(`/native-hardware-audit?surface=${surface}&scenario=${scenario}`);

      if (surface === 'session-infrastructure' && scenario === 'error') {
        await expect(page.getByText('Waiting for capacity')).toBeVisible();
        await expect(page.getByText(/Original request: 2.5 vCPU/)).toBeVisible();
        await expect(
          page.getByText('Strategy under evaluation: pack. Placement uses balanced.')
        ).toBeVisible();
        await expect(
          page.getByText('Placement awaits current authority verification.')
        ).toBeVisible();
      } else if ((surface === 'usage' || surface === 'admin-usage') && scenario === 'error') {
        await expect(page.getByText('Compute usage unavailable')).toBeVisible();
      } else if ((surface === 'usage' || surface === 'admin-usage') && scenario === 'empty') {
        await expect(page.getByText(/No (active nodes|nodes this period)/i)).toBeVisible();
      } else {
        await expect(page.getByLabel('Hardware details').first()).toBeVisible();
        await expect(page.getByLabel('Hardware details').first()).toHaveCSS('display', 'grid');
        if (scenario === 'legacy')
          await expect(page.getByText('Compatibility estimate').first()).toBeVisible();
        else await expect(page.getByText(/12 vCPU/).first()).toBeVisible();
      }
      if (
        surface === 'workspace-sidebar' ||
        (surface === 'session-infrastructure' && scenario !== 'error')
      ) {
        await expect(page.getByText(/Installation-funded pool/)).toBeVisible();
      }
      await expect(page.locator('body')).not.toContainText('SECRET-MUST-NOT-RENDER');
      await expect(page.locator('body')).not.toContainText('PRIVATE-IDENTITY');
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      expect(errors).toEqual([]);
      if (
        scenario === 'normal' ||
        scenario === 'long' ||
        (surface === 'session-infrastructure' && scenario === 'error')
      ) {
        mkdirSync('../../.codex/tmp/playwright-screenshots/native-hardware', { recursive: true });
        await page.waitForTimeout(600);
        await page.screenshot({
          path: `../../.codex/tmp/playwright-screenshots/native-hardware/${surface}-${scenario}-${testInfo.project.name.startsWith('Desktop') ? 'desktop' : testInfo.project.name.startsWith('Narrow') ? '320' : 'mobile'}.png`,
          fullPage: true,
        });
        if (surface === 'usage') {
          const activeNodes = page.getByText('Active Nodes', { exact: true }).locator('..');
          await activeNodes.scrollIntoViewIfNeeded();
          await activeNodes.screenshot({
            path: `../../.codex/tmp/playwright-screenshots/native-hardware/usage-hardware-${scenario}-${testInfo.project.name.startsWith('Desktop') ? 'desktop' : testInfo.project.name.startsWith('Narrow') ? '320' : 'mobile'}.png`,
          });
        }
      }
    });
  }
}
