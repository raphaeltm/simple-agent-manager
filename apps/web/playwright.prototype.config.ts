/**
 * Playwright config for PROTOTYPE-only audits.
 *
 * Prototype routes are registered behind `devOnlyRoutesEnabled()` in App.tsx
 * (`import.meta.env.DEV || MODE === 'test'`), so the base config's
 * `vite build && vite preview` web server — a production-mode build — correctly
 * does NOT contain them. Prototype audits must therefore run against a running
 * dev server, and this config declares no `webServer` of its own.
 *
 * Usage:
 *   npx vite --host 0.0.0.0 --port 5173 &
 *   npx playwright test --config=playwright.prototype.config.ts \
 *     --project="iPhone SE (375x667)" --project="Desktop (1280x800)"
 *
 * Removed together with the prototype it serves.
 */

import { defineConfig } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:5173';

const sharedUse = {
  baseURL,
  trace: 'off' as const,
  screenshot: 'off' as const,
  browserName: 'chromium' as const,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark' as const,
};

export default defineConfig({
  testDir: './tests/playwright',
  testMatch: ['**/comments-prototype-audit.spec.ts'],
  outputDir: '../../.codex/tmp/playwright-screenshots',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  timeout: 30_000,
  projects: [
    {
      name: 'iPhone SE (375x667)',
      use: { ...sharedUse, viewport: { width: 375, height: 667 } },
    },
    {
      name: 'Desktop (1280x800)',
      use: {
        ...sharedUse,
        viewport: { width: 1280, height: 800 },
        isMobile: false,
        hasTouch: false,
      },
    },
  ],
});
