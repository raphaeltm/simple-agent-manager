import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// The harness imports real component modules through Vite; it is not an app route.
process.env.NATIVE_HARDWARE_BROWSER_AUDIT = '1';
export default defineConfig({
  ...base,
  outputDir: '../../.codex/tmp/native-hardware-test-results',
  timeout: 60000,
  expect: { timeout: 20000 },
  testMatch: '**/native-hardware-display.spec.ts',
  projects: [
    ...(base.projects
      ?.filter((project) => /iPhone SE|Desktop/.test(project.name ?? ''))
      .map((project) => ({
        ...project,
        use: { ...project.use, baseURL: 'http://127.0.0.1:4184' },
      })) ?? []),
    {
      name: 'Narrow (320x667)',
      use: {
        browserName: 'chromium',
        baseURL: 'http://127.0.0.1:4184',
        viewport: { width: 320, height: 667 },
      },
    },
  ],
  webServer: {
    command: 'VITE_API_URL=http://127.0.0.1:4184 pnpm exec vite --host 127.0.0.1 --port 4184',
    port: 4184,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
