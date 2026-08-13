import { defineConfig } from '@playwright/test';

const PLAYWRIGHT_PORT = Number(process.env.ARCHITECTURE_PLAYWRIGHT_PORT ?? 49173);

export default defineConfig({
  expect: { timeout: 5_000 },
  fullyParallel: false,
  reporter: [['list']],
  testDir: './tests/playwright',
  timeout: 30_000,
  use: {
    baseURL: `http://127.0.0.1:${PLAYWRIGHT_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `ARCHITECTURE_PLAYWRIGHT_PORT=${PLAYWRIGHT_PORT} corepack pnpm --filter @simple-agent-manager/architecture build && ARCHITECTURE_PLAYWRIGHT_PORT=${PLAYWRIGHT_PORT} corepack pnpm --filter @simple-agent-manager/architecture exec tsx tests/playwright-server.ts`,
    reuseExistingServer: false,
    timeout: 60_000,
    url: `http://127.0.0.1:${PLAYWRIGHT_PORT}/health`,
  },
  projects: [
    { name: 'mobile-375', use: { browserName: 'chromium', isMobile: true, viewport: { width: 375, height: 667 } } },
    { name: 'desktop-1280', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
  ],
});
