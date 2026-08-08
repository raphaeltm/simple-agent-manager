import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  use: {
    baseURL: 'http://127.0.0.1:6006',
    screenshot: 'only-on-failure',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'Desktop Chrome',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      name: 'Mobile Chrome',
      use: { ...devices['Pixel 5'], viewport: { width: 375, height: 667 } },
    },
  ],
  webServer: {
    command: 'python3 -m http.server 6006 --bind 127.0.0.1 --directory storybook-static',
    url: 'http://127.0.0.1:6006/index.json',
    reuseExistingServer: false,
    timeout: 30_000,
  },
});
