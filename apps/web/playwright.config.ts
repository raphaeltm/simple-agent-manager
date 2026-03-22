import { defineConfig } from '@playwright/test';

const sharedUse = {
  baseURL: 'http://localhost:4173',
  trace: 'off' as const,
  screenshot: 'off' as const, // We take manual screenshots
  browserName: 'chromium' as const,
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
  colorScheme: 'dark' as const,
};

export default defineConfig({
  testDir: './tests/playwright',
  outputDir: '../../.codex/tmp/playwright-screenshots',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  projects: [
    {
      name: 'iPhone SE (375x667)',
      use: {
        ...sharedUse,
        viewport: { width: 375, height: 667 },
      },
    },
    {
      name: 'iPhone 14 (390x844)',
      use: {
        ...sharedUse,
        viewport: { width: 390, height: 844 },
      },
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
  webServer: {
    command: 'VITE_API_URL=http://localhost:4173 npx vite build && npx vite preview --port 4173',
    port: 4173,
    reuseExistingServer: true,
    timeout: 60000,
    cwd: '.',
  },
});
