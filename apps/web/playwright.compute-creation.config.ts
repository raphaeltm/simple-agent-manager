import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Real component imports need the Vite module server, never a production route.
export default defineConfig({
  ...base,
  testMatch: '**/compute-creation-browser.spec.ts',
  outputDir: '../../.codex/tmp/compute-creation-test-results',
  timeout: 60000,
  expect: { timeout: 20000 },
  projects: base.projects
    ?.filter((project) => /iPhone SE|Desktop/.test(project.name ?? ''))
    .map((project) => ({
      ...project,
      use: { ...project.use, baseURL: 'http://127.0.0.1:4184' },
    })),
  webServer: {
    command: 'VITE_API_URL=http://127.0.0.1:4184 pnpm exec vite --host 127.0.0.1 --port 4184',
    port: 4184,
    reuseExistingServer: true,
    timeout: 120000,
  },
});
