import { defineConfig } from '@playwright/test';

const isCI = !!process.env.CI;
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173';
const useLocalWebServer =
  baseURL.startsWith('http://localhost:') || baseURL.startsWith('http://127.0.0.1:');

const sharedUse = {
  baseURL,
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
  fullyParallel: isCI, // parallel in CI for speed; serial locally for stable screenshots
  forbidOnly: true,
  retries: 0,
  workers: isCI ? 2 : 1,
  reporter: 'list',
  timeout: isCI ? 15_000 : 30_000, // tighter timeout in CI to fail fast
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
  webServer: useLocalWebServer
    ? {
        command: 'VITE_API_URL=http://localhost:4173 npx vite build && npx vite preview --port 4173',
        port: 4173,
        reuseExistingServer: true,
        timeout: process.env.CI ? 180000 : 60000,
        cwd: '.',
      }
    : undefined,
});
