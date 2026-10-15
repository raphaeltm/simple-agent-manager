import { defineConfig } from '@playwright/test';

import baseConfig from './playwright.config';

// Run separately: native attachment bytes need a real local HTTP response.
// This local-only synthetic HTTP API emits seven inert bytes, never retained user code.
process.env.SAM_RETAINED_EXPORT_NATIVE = '1';
export default defineConfig({
  ...baseConfig,
  testMatch: '**/retained-snapshot-export-audit.spec.ts',
  projects: [
    ...(baseConfig.projects ?? []),
    {
      name: 'Phone narrow (320x667)',
      use: {
        browserName: 'chromium',
        baseURL: 'http://localhost:4173',
        viewport: { width: 320, height: 667 },
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark',
        deviceScaleFactor: 2,
      },
    },
  ],
  workers: 1,
  fullyParallel: false,
  webServer: {
    command: 'VITE_API_URL=http://127.0.0.1:8787 npx vite build && npx vite preview --port 4173',
    port: 4173,
    reuseExistingServer: !process.env.CI,
    timeout: process.env.CI ? 180000 : 60000,
    cwd: '.',
  },
});
