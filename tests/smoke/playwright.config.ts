import { defineConfig } from '@playwright/test';

/**
 * Playwright config for staging smoke tests.
 * Runs against a live deployment (not a local dev server).
 *
 * Required environment variables:
 * - SMOKE_TEST_URL: Base URL of the app (e.g., https://app.sammy.party)
 * - SMOKE_TEST_API_URL: Base URL of the API (e.g., https://api.sammy.party)
 * - SMOKE_TEST_TOKEN: A valid smoke test auth token (sam_test_...)
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: '../../.codex/tmp/smoke-test-results',
  fullyParallel: false,
  forbidOnly: true,
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 30_000,
  use: {
    baseURL: process.env.SMOKE_TEST_URL || 'https://app.sammy.party',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    browserName: 'chromium',
    viewport: { width: 1280, height: 800 },
    // Cookies will be set by the auth helper
  },
  // No webServer — tests run against a live deployment
});
