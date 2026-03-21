import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/playwright',
  outputDir: '../../.codex/tmp/playwright-screenshots',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'off',
    screenshot: 'off', // We take manual screenshots
    // Use Chromium with mobile viewport instead of WebKit device presets
    browserName: 'chromium',
    viewport: { width: 375, height: 667 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    colorScheme: 'dark',
  },
  webServer: {
    command: 'npx vite preview --port 4173',
    port: 4173,
    reuseExistingServer: true,
    cwd: '.',
  },
});
